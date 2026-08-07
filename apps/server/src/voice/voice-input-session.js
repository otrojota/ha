import {
  decodeVoiceInputFrame,
  VOICE_INPUT_CHANNELS,
  VOICE_INPUT_FORMAT,
  VOICE_INPUT_FRAME_BYTES,
  VOICE_INPUT_FRAME_DURATION_MS,
  VOICE_INPUT_SAMPLE_RATE
} from "@ha/contracts";

const STREAM_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PCM_BYTES_PER_MILLISECOND = VOICE_INPUT_SAMPLE_RATE * VOICE_INPUT_CHANNELS * 2 / 1000;
const DEFAULT_RING_BUFFER_MS = 3_000;
const DEFAULT_DISCONTINUITY_MS = 250;

export const VoiceConversationState = Object.freeze({
  IDLE: "idle",
  WAKE_DETECTED: "wake_detected",
  LISTENING: "listening",
  PROCESSING: "processing",
  SPEAKING: "speaking",
  FOLLOW_UP_LISTENING: "follow_up_listening",
  INTERRUPTED: "interrupted"
});

const CONVERSATION_STATES = new Set(Object.values(VoiceConversationState));

function positiveNumber(value, fallback, minimum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

export class PcmRingBuffer {
  constructor({ capacityMs = DEFAULT_RING_BUFFER_MS } = {}) {
    this.capacityMs = positiveNumber(capacityMs, DEFAULT_RING_BUFFER_MS, VOICE_INPUT_FRAME_DURATION_MS);
    this.capacityBytes = Math.max(
      VOICE_INPUT_FRAME_BYTES,
      Math.floor(this.capacityMs * PCM_BYTES_PER_MILLISECOND / 2) * 2
    );
    this.chunks = [];
    this.byteLength = 0;
  }

  append(audio) {
    if (!Buffer.isBuffer(audio) || audio.length === 0) return;
    const chunk = Buffer.from(audio.length > this.capacityBytes ? audio.subarray(audio.length - this.capacityBytes) : audio);
    if (audio.length > this.capacityBytes) this.clear();
    this.chunks.push(chunk);
    this.byteLength += chunk.length;
    this.#trim();
  }

  clear() {
    this.chunks = [];
    this.byteLength = 0;
  }

  readLast(durationMs = this.capacityMs) {
    const requestedBytes = Math.max(0, Math.floor(Number(durationMs) * PCM_BYTES_PER_MILLISECOND / 2) * 2);
    let remaining = Math.min(this.byteLength, requestedBytes);
    if (!remaining) return Buffer.alloc(0);
    const selected = [];
    for (let index = this.chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const chunk = this.chunks[index];
      const take = Math.min(chunk.length, remaining);
      selected.unshift(take === chunk.length ? chunk : chunk.subarray(chunk.length - take));
      remaining -= take;
    }
    return Buffer.concat(selected);
  }

  snapshot() {
    return {
      bufferedBytes: this.byteLength,
      bufferedDurationMs: Number((this.byteLength / PCM_BYTES_PER_MILLISECOND).toFixed(1)),
      ringBufferCapacityBytes: this.capacityBytes,
      ringBufferCapacityMs: Number((this.capacityBytes / PCM_BYTES_PER_MILLISECOND).toFixed(1))
    };
  }

  #trim() {
    while (this.byteLength > this.capacityBytes && this.chunks.length) {
      const overflow = this.byteLength - this.capacityBytes;
      const oldest = this.chunks[0];
      if (oldest.length <= overflow) {
        this.chunks.shift();
        this.byteLength -= oldest.length;
      } else {
        this.chunks[0] = oldest.subarray(overflow);
        this.byteLength -= overflow;
      }
    }
  }
}

function validateStart(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Metadata del stream de micrófono inválida");
  const streamId = String(payload.streamId || "").trim();
  if (!STREAM_ID_PATTERN.test(streamId)) throw new Error("streamId de micrófono inválido");
  if (payload.format !== VOICE_INPUT_FORMAT) throw new Error(`Formato de micrófono no soportado: ${payload.format || "desconocido"}`);
  if (payload.sampleRate !== VOICE_INPUT_SAMPLE_RATE) throw new Error(`sampleRate de micrófono debe ser ${VOICE_INPUT_SAMPLE_RATE}`);
  if (payload.channels !== VOICE_INPUT_CHANNELS) throw new Error(`El micrófono debe transmitir ${VOICE_INPUT_CHANNELS} canal`);
  if (payload.frameDurationMs !== VOICE_INPUT_FRAME_DURATION_MS) {
    throw new Error(`Cada frame de micrófono debe durar ${VOICE_INPUT_FRAME_DURATION_MS} ms`);
  }
  return { streamId };
}

export class VoiceInputSession {
  constructor({
    satelliteId,
    socket,
    payload,
    now = () => Date.now(),
    ringBufferMs = DEFAULT_RING_BUFFER_MS,
    discontinuityMs = DEFAULT_DISCONTINUITY_MS
  }) {
    const { streamId } = validateStart(payload);
    this.satelliteId = satelliteId;
    this.socket = socket;
    this.streamId = streamId;
    this.now = now;
    this.startedAtMs = now();
    this.lastFrameAtMs = null;
    this.expectedSequence = 0;
    this.receivedFrames = 0;
    this.receivedBytes = 0;
    this.lostFrames = 0;
    this.outOfOrderFrames = 0;
    this.latencySamples = 0;
    this.latencyTotalMs = 0;
    this.latencyMaximumMs = 0;
    this.lastCapturedAtMs = null;
    this.sequenceDiscontinuities = 0;
    this.timestampDiscontinuities = 0;
    this.bufferResets = 0;
    this.discontinuityMs = positiveNumber(discontinuityMs, DEFAULT_DISCONTINUITY_MS, VOICE_INPUT_FRAME_DURATION_MS);
    this.audio = new PcmRingBuffer({ capacityMs: ringBufferMs });
    this.state = VoiceConversationState.IDLE;
    this.stateChangedAtMs = this.startedAtMs;
    this.stateReason = "stream_started";
    this.activationId = null;
    this.stateTimeoutMs = null;
  }

  accept(encodedFrame) {
    const frame = decodeVoiceInputFrame(encodedFrame);
    if (frame.streamId !== this.streamId) throw new Error("El frame pertenece a otro stream de micrófono");
    if (frame.sequence < this.expectedSequence) {
      this.outOfOrderFrames += 1;
      return { accepted: false, reason: "out_of_order", frame };
    }
    const sequenceDiscontinuity = frame.sequence > this.expectedSequence;
    if (sequenceDiscontinuity) {
      this.lostFrames += frame.sequence - this.expectedSequence;
      this.sequenceDiscontinuities += 1;
    }
    const capturedDeltaMs = this.lastCapturedAtMs === null
      ? VOICE_INPUT_FRAME_DURATION_MS
      : frame.capturedAtMs - this.lastCapturedAtMs;
    const timestampDiscontinuity = this.lastCapturedAtMs !== null
      && Math.abs(capturedDeltaMs - VOICE_INPUT_FRAME_DURATION_MS) > this.discontinuityMs;
    if (timestampDiscontinuity) this.timestampDiscontinuities += 1;
    if (sequenceDiscontinuity || timestampDiscontinuity) {
      this.audio.clear();
      this.bufferResets += 1;
    }
    this.expectedSequence = frame.sequence + 1;
    this.receivedFrames += 1;
    this.receivedBytes += frame.audio.length;
    this.lastFrameAtMs = this.now();
    const latencyMs = Math.max(0, this.lastFrameAtMs - frame.capturedAtMs);
    this.latencySamples += 1;
    this.latencyTotalMs += latencyMs;
    this.latencyMaximumMs = Math.max(this.latencyMaximumMs, latencyMs);
    this.lastCapturedAtMs = frame.capturedAtMs;
    this.audio.append(frame.audio);
    return { accepted: true, frame, latencyMs, bufferReset: sequenceDiscontinuity || timestampDiscontinuity };
  }

  readRecentAudio(durationMs = this.audio.capacityMs) {
    return this.audio.readLast(durationMs);
  }

  setState(nextState, { reason = null, activationId = null, timeoutMs = null } = {}) {
    if (!CONVERSATION_STATES.has(nextState)) throw new Error(`Estado de conversación inválido: ${nextState}`);
    this.state = nextState;
    this.stateChangedAtMs = this.now();
    this.stateReason = reason === null ? null : String(reason);
    this.activationId = activationId === null ? null : String(activationId);
    this.stateTimeoutMs = timeoutMs === null ? null : Math.max(0, Number(timeoutMs) || 0);
    return this.stateSnapshot();
  }

  stateSnapshot() {
    return {
      state: this.state,
      stateChangedAtMs: this.stateChangedAtMs,
      stateReason: this.stateReason,
      activationId: this.activationId,
      stateTimeoutMs: this.stateTimeoutMs
    };
  }

  snapshot() {
    return {
      satelliteId: this.satelliteId,
      streamId: this.streamId,
      startedAtMs: this.startedAtMs,
      lastFrameAtMs: this.lastFrameAtMs,
      expectedSequence: this.expectedSequence,
      receivedFrames: this.receivedFrames,
      receivedBytes: this.receivedBytes,
      lostFrames: this.lostFrames,
      outOfOrderFrames: this.outOfOrderFrames,
      lastCapturedAtMs: this.lastCapturedAtMs,
      sequenceDiscontinuities: this.sequenceDiscontinuities,
      timestampDiscontinuities: this.timestampDiscontinuities,
      bufferResets: this.bufferResets,
      averageLatencyMs: this.latencySamples ? Number((this.latencyTotalMs / this.latencySamples).toFixed(1)) : null,
      maximumLatencyMs: this.latencySamples ? this.latencyMaximumMs : null,
      ...this.audio.snapshot(),
      ...this.stateSnapshot()
    };
  }
}

export class VoiceInputSessionRegistry {
  constructor({
    now = () => Date.now(),
    log = () => {},
    ringBufferMs = DEFAULT_RING_BUFFER_MS,
    discontinuityMs = DEFAULT_DISCONTINUITY_MS
  } = {}) {
    this.now = now;
    this.log = log;
    this.ringBufferMs = positiveNumber(ringBufferMs, DEFAULT_RING_BUFFER_MS, VOICE_INPUT_FRAME_DURATION_MS);
    this.discontinuityMs = positiveNumber(discontinuityMs, DEFAULT_DISCONTINUITY_MS, VOICE_INPUT_FRAME_DURATION_MS);
    this.sessions = new Map();
  }

  start(socket, event) {
    const satelliteId = String(socket?.satelliteId || "").trim();
    if (!satelliteId) throw new Error("El socket debe registrarse antes de iniciar audio");
    if (event.source !== satelliteId) throw new Error("El stream no pertenece al satélite registrado");
    const previous = this.sessions.get(satelliteId);
    if (previous) this.log("info", "Stream de micrófono reemplazado", { ...previous.snapshot(), reason: "replaced" });
    const session = new VoiceInputSession({
      satelliteId,
      socket,
      payload: event.payload,
      now: this.now,
      ringBufferMs: this.ringBufferMs,
      discontinuityMs: this.discontinuityMs
    });
    this.sessions.set(satelliteId, session);
    this.log("info", "Stream de micrófono registrado", {
      satelliteId,
      streamId: session.streamId,
      sampleRate: VOICE_INPUT_SAMPLE_RATE,
      frameDurationMs: VOICE_INPUT_FRAME_DURATION_MS
    });
    return session;
  }

  accept(socket, encodedFrame) {
    const satelliteId = String(socket?.satelliteId || "").trim();
    const session = this.sessions.get(satelliteId);
    if (!session || session.socket !== socket) throw new Error("No existe un stream de micrófono activo para este socket");
    return session.accept(encodedFrame);
  }

  end(socket, event) {
    const satelliteId = String(socket?.satelliteId || "").trim();
    const session = this.sessions.get(satelliteId);
    if (!session || session.socket !== socket) return null;
    if (event.source !== satelliteId || event.payload?.streamId !== session.streamId) {
      throw new Error("El cierre no pertenece al stream de micrófono activo");
    }
    this.sessions.delete(satelliteId);
    const summary = { ...session.snapshot(), reason: String(event.payload.reason || "ended") };
    this.log("info", "Stream de micrófono cerrado", summary);
    return summary;
  }

  remove(socket, reason = "socket_closed") {
    const satelliteId = String(socket?.satelliteId || "").trim();
    const session = this.sessions.get(satelliteId);
    if (!session || session.socket !== socket) return null;
    this.sessions.delete(satelliteId);
    const summary = { ...session.snapshot(), reason };
    this.log("info", "Stream de micrófono eliminado", summary);
    return summary;
  }

  logMetrics() {
    for (const session of this.sessions.values()) {
      this.log("info", "Métricas del stream de micrófono", session.snapshot());
    }
  }

  snapshot(satelliteId) {
    return this.sessions.get(String(satelliteId || "").trim())?.snapshot() || null;
  }

  session(satelliteId) {
    return this.sessions.get(String(satelliteId || "").trim()) || null;
  }

  list() {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }

  activeCount() {
    return this.sessions.size;
  }
}
