import { randomUUID } from "node:crypto";
import { encodeAudioFrame, createEvent, EventType } from "@ha/contracts";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class TtsStreamService {
  constructor({
    provider,
    voiceConfig,
    sockets,
    log = () => {},
    onStreamStarted = () => {},
    onStreamFailed = () => {}
  }) {
    this.provider = provider;
    this.voiceConfig = voiceConfig;
    this.sockets = sockets;
    this.log = log;
    this.onStreamStarted = onStreamStarted;
    this.onStreamFailed = onStreamFailed;
    this.active = new Map();
  }

  async catalog(satelliteId) {
    const voices = await this.provider.listVoices();
    return {
      provider: this.provider.name,
      voices,
      selectedVoiceId: this.voiceConfig.voiceFor(satelliteId, voices)
    };
  }

  async assign(satelliteId, voiceId) {
    const voices = await this.provider.listVoices();
    await this.voiceConfig.assign(satelliteId, voiceId, voices);
    return this.catalog(satelliteId);
  }

  cancel(satelliteId, reason = "replaced") {
    const active = this.active.get(satelliteId);
    if (!active) return false;
    active.cancelReason = reason;
    active.controller.abort(new Error(`Stream TTS cancelado: ${reason}`));
    return true;
  }

  isConnected(satelliteId) { return Boolean(this.sockets.get(satelliteId)); }

  async speak(text, satelliteId, {
    expectsReply = false,
    followUpTimeoutMs = 0,
    responseId = null,
    activationId = null
  } = {}) {
    const target = String(satelliteId || "").trim();
    if (!target) throw new Error("satelliteId es obligatorio para TTS");
    const socket = this.sockets.get(target);
    if (!socket) throw new Error(`El satélite ${target} no está conectado`);
    this.cancel(target);
    const streamId = randomUUID();
    const controller = new AbortController();
    this.active.set(target, { streamId, controller, cancelReason: null });
    const sendEvent = (type, payload) => {
      if (socket.readyState !== socket.OPEN) throw new Error("El satélite se desconectó durante el TTS");
      socket.send(JSON.stringify(createEvent(type, { ...payload, targetSatelliteId: target }, "server")));
    };
    try {
      const catalog = await this.catalog(target);
      const voice = catalog.voices.find((item) => item.id === catalog.selectedVoiceId);
      if (!voice) throw new Error("No hay voces TTS disponibles en el servidor");
      sendEvent(EventType.ASSISTANT_SPEECH_STREAM_STARTED, {
        streamId,
        responseId,
        voiceId: voice.id,
        format: "pcm_s16le",
        sampleRate: Number(voice.sampleRate || this.provider.sampleRate || 22050),
        channels: 1,
        expectsReply,
        followUpTimeoutMs,
        activationId
      });
      this.onStreamStarted({ satelliteId: target, streamId, responseId, activationId, expectsReply, followUpTimeoutMs });
      let sequence = 0;
      let bytes = 0;
      const synthesisStartedAt = Date.now();
      let firstAudioMs = null;
      for await (const chunk of this.provider.synthesize(text, { voiceId: voice.id, signal: controller.signal })) {
        if (controller.signal.aborted) throw controller.signal.reason;
        while (socket.bufferedAmount > 512 * 1024) {
          if (socket.readyState !== socket.OPEN) throw new Error("El satélite se desconectó durante el TTS");
          await wait(10);
        }
        const audio = Buffer.from(chunk);
        if (firstAudioMs === null) firstAudioMs = Date.now() - synthesisStartedAt;
        socket.send(encodeAudioFrame(streamId, sequence, audio), { binary: true });
        sequence += 1;
        bytes += audio.length;
      }
      sendEvent(EventType.ASSISTANT_SPEECH_STREAM_ENDED, { streamId, chunks: sequence, bytes });
      this.log("info", "Stream TTS enviado", { satelliteId: target, streamId, voiceId: voice.id, chunks: sequence, bytes, firstAudioMs });
      return { streamId, voiceId: voice.id, chunks: sequence, bytes, firstAudioMs };
    } catch (error) {
      const cancelReason = this.active.get(target)?.streamId === streamId
        ? this.active.get(target).cancelReason
        : null;
      if (socket.readyState === socket.OPEN) {
        sendEvent(EventType.ASSISTANT_SPEECH_STREAM_FAILED, {
          streamId,
          message: error.message,
          ...(cancelReason ? { reason: cancelReason } : {})
        });
      }
      if (this.active.get(target)?.streamId === streamId) {
        this.onStreamFailed({ satelliteId: target, streamId, responseId, activationId, error, reason: cancelReason });
      }
      throw error;
    } finally {
      if (this.active.get(target)?.streamId === streamId) this.active.delete(target);
    }
  }
}
