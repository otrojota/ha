import { randomUUID } from "node:crypto";
import { VoiceConversationState } from "./voice-input-session.js";

const ALLOWED_TRANSITIONS = new Map([
  [VoiceConversationState.IDLE, new Set([VoiceConversationState.WAKE_DETECTED, VoiceConversationState.LISTENING])],
  [VoiceConversationState.WAKE_DETECTED, new Set([VoiceConversationState.LISTENING, VoiceConversationState.IDLE])],
  [VoiceConversationState.LISTENING, new Set([
    VoiceConversationState.PROCESSING,
    VoiceConversationState.SPEAKING,
    VoiceConversationState.INTERRUPTED,
    VoiceConversationState.IDLE
  ])],
  [VoiceConversationState.PROCESSING, new Set([
    VoiceConversationState.SPEAKING,
    VoiceConversationState.FOLLOW_UP_LISTENING,
    VoiceConversationState.INTERRUPTED,
    VoiceConversationState.IDLE
  ])],
  [VoiceConversationState.SPEAKING, new Set([
    VoiceConversationState.FOLLOW_UP_LISTENING,
    VoiceConversationState.INTERRUPTED,
    VoiceConversationState.IDLE
  ])],
  [VoiceConversationState.FOLLOW_UP_LISTENING, new Set([
    VoiceConversationState.LISTENING,
    VoiceConversationState.PROCESSING,
    VoiceConversationState.INTERRUPTED,
    VoiceConversationState.IDLE
  ])],
  [VoiceConversationState.INTERRUPTED, new Set([VoiceConversationState.LISTENING, VoiceConversationState.IDLE])]
]);

const ACTIVE_ACTIVATION_STATES = new Set([
  VoiceConversationState.WAKE_DETECTED,
  VoiceConversationState.LISTENING,
  VoiceConversationState.FOLLOW_UP_LISTENING
]);

export class VoiceStateCoordinator {
  constructor({
    sessions,
    publish,
    requestListening = () => {},
    now = () => Date.now(),
    createActivationId = randomUUID,
    log = () => {}
  }) {
    this.sessions = sessions;
    this.publish = publish;
    this.requestListening = requestListening;
    this.now = now;
    this.createActivationId = createActivationId;
    this.log = log;
    this.runtime = new Map();
  }

  register(satelliteId) {
    const id = this.#id(satelliteId);
    this.#clearTimer(id);
    this.runtime.set(id, { timer: null, metadata: {} });
    return this.transition(id, VoiceConversationState.IDLE, { reason: "stream_started", force: true });
  }

  activate(satelliteId, {
    reason,
    timeoutMs,
    requestListening = false,
    metadata = {}
  }) {
    const id = this.#id(satelliteId);
    const session = this.#session(id);
    if (ACTIVE_ACTIVATION_STATES.has(session.state)) {
      return { accepted: false, activationId: session.activationId, state: session.state };
    }
    if (session.state !== VoiceConversationState.IDLE) {
      return { accepted: false, activationId: session.activationId, state: session.state };
    }
    const activationId = this.createActivationId();
    this.#runtime(id).metadata = { ...metadata };
    this.transition(id, VoiceConversationState.WAKE_DETECTED, { reason, activationId });
    const state = this.transition(id, VoiceConversationState.LISTENING, {
      reason: `${reason}_listening`,
      activationId,
      timeoutMs
    });
    if (requestListening) {
      this.requestListening(id, {
        activationId,
        timeoutMs: state.timeoutMs,
        reason
      });
    }
    return { accepted: true, activationId, state: state.state };
  }

  processing(satelliteId, { reason = "command_captured", activationId = null } = {}) {
    const id = this.#id(satelliteId);
    const session = this.#session(id);
    if (session.state === VoiceConversationState.IDLE) {
      this.activate(id, { reason: "command_without_activation", timeoutMs: null });
    }
    return this.transition(id, VoiceConversationState.PROCESSING, {
      reason,
      activationId: activationId || this.#session(id).activationId
    });
  }

  speaking(satelliteId, { reason = "tts_started", activationId = null } = {}) {
    const id = this.#id(satelliteId);
    const session = this.#session(id);
    if (session.state === VoiceConversationState.IDLE) {
      this.activate(id, { reason: "server_response", timeoutMs: null });
      this.processing(id, { reason: "response_ready" });
    }
    return this.transition(id, VoiceConversationState.SPEAKING, {
      reason,
      activationId: activationId || this.#session(id).activationId
    });
  }

  followUp(satelliteId, { timeoutMs, reason = "response_expects_reply", requestListening = false } = {}) {
    const id = this.#id(satelliteId);
    const state = this.transition(id, VoiceConversationState.FOLLOW_UP_LISTENING, {
      reason,
      activationId: this.#session(id).activationId,
      timeoutMs
    });
    if (requestListening) {
      this.requestListening(id, {
        activationId: this.#session(id).activationId,
        timeoutMs: state.timeoutMs,
        reason
      });
    }
    return state;
  }

  refreshListening(satelliteId, { timeoutMs, reason = "speech_recognized" } = {}) {
    const id = this.#id(satelliteId);
    const session = this.#session(id);
    if (![VoiceConversationState.LISTENING, VoiceConversationState.FOLLOW_UP_LISTENING].includes(session.state)) {
      return session.stateSnapshot();
    }
    return this.transition(id, session.state, {
      reason,
      activationId: session.activationId,
      timeoutMs,
      force: true
    });
  }

  interruptAndListen(satelliteId, { timeoutMs, reason = "spoken_interruption" } = {}) {
    const id = this.#id(satelliteId);
    const previousActivationId = this.#session(id).activationId;
    this.transition(id, VoiceConversationState.INTERRUPTED, { reason, activationId: previousActivationId });
    const activationId = this.createActivationId();
    return this.transition(id, VoiceConversationState.LISTENING, {
      reason: `${reason}_listening`,
      activationId,
      timeoutMs
    });
  }

  metadata(satelliteId) {
    const id = String(satelliteId || "").trim();
    return id && this.runtime.has(id) ? { ...this.#runtime(id).metadata } : {};
  }

  complete(satelliteId, reason = "completed") {
    const id = this.#id(satelliteId);
    const session = this.#session(id);
    if (session.state === VoiceConversationState.IDLE) return session.stateSnapshot();
    return this.transition(id, VoiceConversationState.IDLE, { reason });
  }

  transition(satelliteId, nextState, {
    reason = null,
    activationId = null,
    timeoutMs = null,
    force = false
  } = {}) {
    const id = this.#id(satelliteId);
    const session = this.#session(id);
    const previousState = session.state;
    if (!force && previousState === nextState) return session.stateSnapshot();
    if (!force && !ALLOWED_TRANSITIONS.get(previousState)?.has(nextState)) {
      throw new Error(`Transición de voz inválida para ${id}: ${previousState} -> ${nextState}`);
    }
    this.#clearTimer(id);
    const currentActivationId = activationId || session.activationId || null;
    const normalizedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.round(Number(timeoutMs))
      : null;
    const expiresAtMs = normalizedTimeoutMs ? this.now() + normalizedTimeoutMs : null;
    const state = session.setState(nextState, {
      reason,
      activationId: nextState === VoiceConversationState.IDLE ? null : currentActivationId,
      timeoutMs: normalizedTimeoutMs
    });
    const payload = {
      targetSatelliteId: id,
      state: nextState,
      previousState,
      reason,
      activationId: currentActivationId,
      timeoutMs: normalizedTimeoutMs,
      expiresAtMs,
      ...this.#runtime(id).metadata
    };
    this.publish(payload);
    this.log("info", "Estado de voz actualizado", payload);
    if (expiresAtMs) {
      const timer = setTimeout(() => {
        const current = this.sessions.session(id);
        if (!current || current.state !== nextState || current.activationId !== currentActivationId) return;
        this.complete(id, `${nextState}_timeout`);
      }, normalizedTimeoutMs);
      timer.unref?.();
      this.#runtime(id).timer = timer;
    }
    if (nextState === VoiceConversationState.IDLE) this.#runtime(id).metadata = {};
    return { ...state, timeoutMs: normalizedTimeoutMs, expiresAtMs };
  }

  remove(satelliteId) {
    const id = String(satelliteId || "").trim();
    if (!id) return false;
    this.#clearTimer(id);
    this.runtime.delete(id);
    return true;
  }

  list() {
    return this.sessions.list().map((session) => ({
      satelliteId: session.satelliteId,
      state: session.state,
      stateChangedAtMs: session.stateChangedAtMs,
      reason: session.stateReason,
      activationId: session.activationId,
      timeoutMs: session.stateTimeoutMs
    }));
  }

  close() {
    for (const id of this.runtime.keys()) this.#clearTimer(id);
    this.runtime.clear();
  }

  #id(value) {
    const id = String(value || "").trim();
    if (!id) throw new Error("satelliteId es obligatorio para el estado de voz");
    return id;
  }

  #session(id) {
    const session = this.sessions.session(id);
    if (!session) throw new Error(`No existe una sesión de audio para ${id}`);
    return session;
  }

  #runtime(id) {
    if (!this.runtime.has(id)) this.runtime.set(id, { timer: null, metadata: {} });
    return this.runtime.get(id);
  }

  #clearTimer(id) {
    const runtime = this.runtime.get(id);
    if (runtime?.timer) clearTimeout(runtime.timer);
    if (runtime) runtime.timer = null;
  }
}
