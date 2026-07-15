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
  return {
    id: crypto.randomUUID(),
    type,
    source,
    timestamp: new Date().toISOString(),
    payload
  };
}

export function isEvent(value) {
  return Boolean(value && typeof value === "object" && typeof value.type === "string" && value.payload);
}
