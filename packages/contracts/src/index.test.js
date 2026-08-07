import assert from "node:assert/strict";
import test from "node:test";
import {
  createEvent, decodeAudioFrame, decodeVoiceInputFrame, encodeAudioFrame, encodeVoiceInputFrame,
  EventType, isEvent, isVoiceInputFrame, PROTOCOL_VERSION, requireSatelliteId, VOICE_INPUT_FRAME_BYTES
} from "./index.js";

test("crea únicamente eventos del protocolo actual", () => {
  const event = createEvent(EventType.SATELLITE_CONNECTED, { ready: true }, "satellite-rpi");
  assert.equal(event.protocolVersion, PROTOCOL_VERSION);
  assert.equal(isEvent(event), true);
  assert.equal(isEvent({ ...event, protocolVersion: "1" }), false);
  assert.equal(isEvent({ ...event, type: "unknown.event" }), false);
});

test("codifica frames PCM con stream y secuencia", () => {
  const streamId = "12345678-1234-1234-1234-123456789abc";
  const decoded = decodeAudioFrame(encodeAudioFrame(streamId, 42, Buffer.from([1, 2, 3])));
  assert.equal(decoded.streamId, streamId);
  assert.equal(decoded.sequence, 42);
  assert.deepEqual(decoded.audio, Buffer.from([1, 2, 3]));
});

test("distingue y codifica frames PCM entrantes con timestamp", () => {
  const streamId = "12345678-1234-1234-1234-123456789abc";
  const audio = Buffer.alloc(VOICE_INPUT_FRAME_BYTES, 7);
  const encoded = encodeVoiceInputFrame(streamId, 42, 1_786_000_000_123, audio);
  assert.equal(isVoiceInputFrame(encoded), true);
  assert.equal(isVoiceInputFrame(encodeAudioFrame(streamId, 1, audio)), false);
  const decoded = decodeVoiceInputFrame(encoded);
  assert.equal(decoded.streamId, streamId);
  assert.equal(decoded.sequence, 42);
  assert.equal(decoded.capturedAtMs, 1_786_000_000_123);
  assert.deepEqual(decoded.audio, audio);
});

test("rechaza frames de micrófono con una duración distinta de 20 ms", () => {
  assert.throws(() => encodeVoiceInputFrame(
    "12345678-1234-1234-1234-123456789abc", 0, Date.now(), Buffer.alloc(100)
  ), /640 bytes/);
});

test("satelliteId es obligatorio en operaciones con alcance", () => {
  assert.equal(requireSatelliteId(" satellite-rpi "), "satellite-rpi");
  assert.throws(() => requireSatelliteId(""), /Satellite-Id/);
});
