export const PROTOCOL_VERSION = "5";

export const VOICE_INPUT_FORMAT = "pcm_s16le";
export const VOICE_INPUT_SAMPLE_RATE = 16_000;
export const VOICE_INPUT_CHANNELS = 1;
export const VOICE_INPUT_FRAME_DURATION_MS = 20;
export const VOICE_INPUT_FRAME_BYTES = 640;

export const EventType = Object.freeze({
  SATELLITE_CONNECTED: "satellite.connected",
  SATELLITE_HEARTBEAT: "satellite.heartbeat",
  VOICE_STATE_CHANGED: "voice.state.changed",
  VOICE_LISTEN_REQUESTED: "voice.listen.requested",
  WAKE_WORD_CONFIGURED: "voice.wake-word.configured",
  VOICE_INPUT_STREAM_STARTED: "voice.input.stream.started",
  VOICE_INPUT_STREAM_ENDED: "voice.input.stream.ended",
  TRANSCRIPT_PARTIAL: "voice.transcript.partial",
  TRANSCRIPT_RECEIVED: "voice.transcript.received",
  ASSISTANT_PROCESSING: "assistant.processing.started",
  ASSISTANT_RESPONSE: "assistant.response.created",
  ASSISTANT_SPEECH_STREAM_STARTED: "assistant.speech.stream.started",
  ASSISTANT_SPEECH_STREAM_ENDED: "assistant.speech.stream.ended",
  ASSISTANT_SPEECH_STREAM_FAILED: "assistant.speech.stream.failed",
  ASSISTANT_SPEECH_PLAYBACK_ENDED: "assistant.speech.playback.ended",
  WEATHER_UPDATED: "weather.updated"
});

const AUDIO_FRAME_MAGIC = "HAT1";
const AUDIO_FRAME_HEADER_BYTES = 44;
const VOICE_INPUT_FRAME_MAGIC = "HAI1";
const VOICE_INPUT_FRAME_HEADER_BYTES = 52;

export function encodeAudioFrame(streamId, sequence, audio) {
  const id = String(streamId || "");
  if (Buffer.byteLength(id, "ascii") !== 36) throw new Error("streamId debe tener 36 caracteres ASCII");
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new Error("sequence no es válido");
  const pcm = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
  const frame = Buffer.allocUnsafe(AUDIO_FRAME_HEADER_BYTES + pcm.length);
  frame.write(AUDIO_FRAME_MAGIC, 0, 4, "ascii");
  frame.write(id, 4, 36, "ascii");
  frame.writeUInt32BE(sequence, 40);
  pcm.copy(frame, AUDIO_FRAME_HEADER_BYTES);
  return frame;
}

export function decodeAudioFrame(frame) {
  const data = Buffer.isBuffer(frame) ? frame : Buffer.from(frame || []);
  if (data.length < AUDIO_FRAME_HEADER_BYTES || data.toString("ascii", 0, 4) !== AUDIO_FRAME_MAGIC) {
    throw new Error("Frame de audio inválido");
  }
  return {
    streamId: data.toString("ascii", 4, 40),
    sequence: data.readUInt32BE(40),
    audio: data.subarray(AUDIO_FRAME_HEADER_BYTES)
  };
}

export function encodeVoiceInputFrame(streamId, sequence, capturedAtMs, audio) {
  const id = String(streamId || "");
  if (Buffer.byteLength(id, "ascii") !== 36) throw new Error("streamId debe tener 36 caracteres ASCII");
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new Error("sequence no es válido");
  if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0) throw new Error("capturedAtMs no es válido");
  const pcm = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
  if (pcm.length !== VOICE_INPUT_FRAME_BYTES) {
    throw new Error(`Cada frame de micrófono debe contener ${VOICE_INPUT_FRAME_BYTES} bytes`);
  }
  const frame = Buffer.allocUnsafe(VOICE_INPUT_FRAME_HEADER_BYTES + pcm.length);
  frame.write(VOICE_INPUT_FRAME_MAGIC, 0, 4, "ascii");
  frame.write(id, 4, 36, "ascii");
  frame.writeUInt32BE(sequence, 40);
  frame.writeBigUInt64BE(BigInt(capturedAtMs), 44);
  pcm.copy(frame, VOICE_INPUT_FRAME_HEADER_BYTES);
  return frame;
}

export function decodeVoiceInputFrame(frame) {
  const data = Buffer.isBuffer(frame) ? frame : Buffer.from(frame || []);
  if (data.length !== VOICE_INPUT_FRAME_HEADER_BYTES + VOICE_INPUT_FRAME_BYTES
    || data.toString("ascii", 0, 4) !== VOICE_INPUT_FRAME_MAGIC) {
    throw new Error("Frame de micrófono inválido");
  }
  const capturedAt = data.readBigUInt64BE(44);
  if (capturedAt > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("capturedAtMs excede el rango seguro");
  return {
    streamId: data.toString("ascii", 4, 40),
    sequence: data.readUInt32BE(40),
    capturedAtMs: Number(capturedAt),
    audio: data.subarray(VOICE_INPUT_FRAME_HEADER_BYTES)
  };
}

export function isVoiceInputFrame(frame) {
  const data = Buffer.isBuffer(frame) ? frame : Buffer.from(frame || []);
  return data.length >= 4 && data.toString("ascii", 0, 4) === VOICE_INPUT_FRAME_MAGIC;
}

export function createEvent(type, payload = {}, source = "unknown") {
  if (!Object.values(EventType).includes(type)) throw new Error(`Tipo de evento desconocido: ${type}`);
  if (!source || typeof source !== "string") throw new Error("Todo evento necesita un source");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("El payload del evento debe ser un objeto");
  return {
    id: crypto.randomUUID(),
    protocolVersion: PROTOCOL_VERSION,
    type,
    source,
    timestamp: new Date().toISOString(),
    payload
  };
}

export function isEvent(value) {
  return Boolean(value
    && typeof value === "object"
    && value.protocolVersion === PROTOCOL_VERSION
    && typeof value.id === "string"
    && Object.values(EventType).includes(value.type)
    && typeof value.source === "string"
    && value.payload
    && typeof value.payload === "object"
    && !Array.isArray(value.payload));
}

export function requireSatelliteId(value) {
  const satelliteId = String(value || "").trim();
  if (!satelliteId) throw new Error("X-Satellite-Id es obligatorio");
  return satelliteId;
}
