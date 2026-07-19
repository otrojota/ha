export const PROTOCOL_VERSION = "2";

export const EventType = Object.freeze({
  SATELLITE_CONNECTED: "satellite.connected",
  SATELLITE_HEARTBEAT: "satellite.heartbeat",
  AUDIO_LEVEL_UPDATED: "audio.level.updated",
  WAKE_WORD_DETECTED: "voice.wake-word.detected",
  LISTENING_ENDED: "voice.listening.ended",
  FOLLOW_UP_LISTENING_STARTED: "voice.follow-up-listening.started",
  TRANSCRIPT_RECEIVED: "voice.transcript.received",
  ASSISTANT_PROCESSING: "assistant.processing.started",
  ASSISTANT_RESPONSE: "assistant.response.created",
  ASSISTANT_SPEECH_REQUESTED: "assistant.speech.requested",
  PLAYBACK_CHANGED: "music.playback.changed",
  WEATHER_UPDATED: "weather.updated"
});

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
