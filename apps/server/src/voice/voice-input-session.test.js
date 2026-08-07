import assert from "node:assert/strict";
import test from "node:test";
import { createEvent, encodeVoiceInputFrame, EventType, VOICE_INPUT_FRAME_BYTES } from "@ha/contracts";
import {
  PcmRingBuffer,
  VoiceConversationState,
  VoiceInputSessionRegistry
} from "./voice-input-session.js";

const streamId = "12345678-1234-4234-9234-123456789abc";
const started = (source = "sat-1", id = streamId) => createEvent(EventType.VOICE_INPUT_STREAM_STARTED, {
  streamId: id,
  format: "pcm_s16le",
  sampleRate: 16_000,
  channels: 1,
  frameDurationMs: 20
}, source);

test("registra frames, pérdidas y latencia por satélite", () => {
  let now = 2_000;
  const registry = new VoiceInputSessionRegistry({ now: () => now });
  const socket = { satelliteId: "sat-1" };
  registry.start(socket, started());
  registry.accept(socket, encodeVoiceInputFrame(streamId, 0, 1_990, Buffer.alloc(VOICE_INPUT_FRAME_BYTES)));
  now = 2_025;
  registry.accept(socket, encodeVoiceInputFrame(streamId, 2, 2_000, Buffer.alloc(VOICE_INPUT_FRAME_BYTES)));
  const metrics = registry.snapshot("sat-1");
  assert.equal(metrics.receivedFrames, 2);
  assert.equal(metrics.receivedBytes, VOICE_INPUT_FRAME_BYTES * 2);
  assert.equal(metrics.lostFrames, 1);
  assert.equal(metrics.averageLatencyMs, 17.5);
  assert.equal(metrics.maximumLatencyMs, 25);
});

test("descarta frames atrasados sin contaminar las métricas recibidas", () => {
  const registry = new VoiceInputSessionRegistry();
  const socket = { satelliteId: "sat-1" };
  registry.start(socket, started());
  registry.accept(socket, encodeVoiceInputFrame(streamId, 1, Date.now(), Buffer.alloc(VOICE_INPUT_FRAME_BYTES)));
  const result = registry.accept(socket, encodeVoiceInputFrame(streamId, 0, Date.now(), Buffer.alloc(VOICE_INPUT_FRAME_BYTES)));
  assert.equal(result.accepted, false);
  assert.equal(registry.snapshot("sat-1").receivedFrames, 1);
  assert.equal(registry.snapshot("sat-1").outOfOrderFrames, 1);
});

test("aísla la sesión por socket y satélite", () => {
  const registry = new VoiceInputSessionRegistry();
  const owner = { satelliteId: "sat-1" };
  const intruder = { satelliteId: "sat-1" };
  registry.start(owner, started());
  assert.throws(() => registry.accept(
    intruder,
    encodeVoiceInputFrame(streamId, 0, Date.now(), Buffer.alloc(VOICE_INPUT_FRAME_BYTES))
  ), /No existe un stream/);
  assert.throws(() => registry.start({ satelliteId: "sat-2" }, started("sat-1")), /no pertenece/);
});

test("el cierre de un socket reemplazado no elimina la sesión nueva", () => {
  const registry = new VoiceInputSessionRegistry();
  const previous = { satelliteId: "sat-1" };
  const current = { satelliteId: "sat-1" };
  registry.start(previous, started());
  registry.start(current, started("sat-1", "abcdefab-1234-4234-9234-123456789abc"));
  assert.equal(registry.remove(previous), null);
  assert.equal(registry.snapshot("sat-1").streamId, "abcdefab-1234-4234-9234-123456789abc");
});

test("el ring buffer conserva sólo el audio PCM más reciente", () => {
  const ring = new PcmRingBuffer({ capacityMs: 60 });
  for (let value = 1; value <= 4; value += 1) ring.append(Buffer.alloc(VOICE_INPUT_FRAME_BYTES, value));
  assert.deepEqual(ring.snapshot(), {
    bufferedBytes: VOICE_INPUT_FRAME_BYTES * 3,
    bufferedDurationMs: 60,
    ringBufferCapacityBytes: VOICE_INPUT_FRAME_BYTES * 3,
    ringBufferCapacityMs: 60
  });
  const recent = ring.readLast(40);
  assert.equal(recent.length, VOICE_INPUT_FRAME_BYTES * 2);
  assert.equal(recent[0], 3);
  assert.equal(recent[VOICE_INPUT_FRAME_BYTES], 4);
});

test("reinicia el ring buffer ante pérdidas de secuencia", () => {
  const registry = new VoiceInputSessionRegistry({ ringBufferMs: 200 });
  const socket = { satelliteId: "sat-1" };
  registry.start(socket, started());
  registry.accept(socket, encodeVoiceInputFrame(streamId, 0, 1_000, Buffer.alloc(VOICE_INPUT_FRAME_BYTES, 1)));
  registry.accept(socket, encodeVoiceInputFrame(streamId, 1, 1_020, Buffer.alloc(VOICE_INPUT_FRAME_BYTES, 2)));
  const result = registry.accept(socket, encodeVoiceInputFrame(streamId, 3, 1_060, Buffer.alloc(VOICE_INPUT_FRAME_BYTES, 3)));
  const session = registry.session("sat-1");
  assert.equal(result.bufferReset, true);
  assert.equal(session.snapshot().sequenceDiscontinuities, 1);
  assert.equal(session.snapshot().bufferResets, 1);
  assert.equal(session.snapshot().bufferedDurationMs, 20);
  assert.equal(session.readRecentAudio()[0], 3);
});

test("reinicia el ring buffer ante un salto temporal aunque la secuencia continúe", () => {
  const registry = new VoiceInputSessionRegistry({ ringBufferMs: 200, discontinuityMs: 100 });
  const socket = { satelliteId: "sat-1" };
  registry.start(socket, started());
  registry.accept(socket, encodeVoiceInputFrame(streamId, 0, 1_000, Buffer.alloc(VOICE_INPUT_FRAME_BYTES, 1)));
  registry.accept(socket, encodeVoiceInputFrame(streamId, 1, 2_000, Buffer.alloc(VOICE_INPUT_FRAME_BYTES, 2)));
  const metrics = registry.snapshot("sat-1");
  assert.equal(metrics.timestampDiscontinuities, 1);
  assert.equal(metrics.bufferResets, 1);
  assert.equal(metrics.bufferedDurationMs, 20);
  assert.equal(registry.session("sat-1").readRecentAudio()[0], 2);
});

test("mantiene el estado conversacional interno por sesión", () => {
  let now = 1_000;
  const registry = new VoiceInputSessionRegistry({ now: () => now });
  const socket = { satelliteId: "sat-1" };
  const session = registry.start(socket, started());
  assert.equal(session.snapshot().state, VoiceConversationState.IDLE);
  now = 1_500;
  session.setState(VoiceConversationState.LISTENING, {
    reason: "wake_word_detected",
    activationId: "activation-1",
    timeoutMs: 4_000
  });
  assert.deepEqual(session.stateSnapshot(), {
    state: "listening",
    stateChangedAtMs: 1_500,
    stateReason: "wake_word_detected",
    activationId: "activation-1",
    stateTimeoutMs: 4_000
  });
  assert.throws(() => session.setState("unknown"), /Estado de conversación inválido/);
});

test("lista diagnósticos aislados sin exponer el PCM ni el socket", () => {
  const registry = new VoiceInputSessionRegistry();
  const socket = { satelliteId: "sat-1" };
  registry.start(socket, started());
  registry.accept(socket, encodeVoiceInputFrame(streamId, 0, Date.now(), Buffer.alloc(VOICE_INPUT_FRAME_BYTES)));
  const [diagnostic] = registry.list();
  assert.equal(diagnostic.satelliteId, "sat-1");
  assert.equal(diagnostic.bufferedBytes, VOICE_INPUT_FRAME_BYTES);
  assert.equal("audio" in diagnostic, false);
  assert.equal("socket" in diagnostic, false);
});
