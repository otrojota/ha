import assert from "node:assert/strict";
import test from "node:test";
import { createEvent, EventType } from "@ha/contracts";
import { VoiceInputSessionRegistry } from "./voice-input-session.js";
import { VoiceStateCoordinator } from "./voice-state-coordinator.js";

const streamId = "12345678-1234-4234-9234-123456789abc";

function fixture(createActivationId = () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
  const sessions = new VoiceInputSessionRegistry();
  const socket = { satelliteId: "sat-1" };
  sessions.start(socket, createEvent(EventType.VOICE_INPUT_STREAM_STARTED, {
    streamId,
    format: "pcm_s16le",
    sampleRate: 16_000,
    channels: 1,
    frameDurationMs: 20
  }, "sat-1"));
  const published = [];
  const requested = [];
  const coordinator = new VoiceStateCoordinator({
    sessions,
    publish: (payload) => published.push(payload),
    requestListening: (satelliteId, payload) => requested.push({ satelliteId, payload }),
    createActivationId
  });
  coordinator.register("sat-1");
  published.length = 0;
  return { sessions, coordinator, published, requested };
}

test("activa escucha con activationId y solicita captura al satélite", () => {
  const { sessions, coordinator, published, requested } = fixture();
  const result = coordinator.activate("sat-1", {
    reason: "central_wake_word",
    timeoutMs: 4_000,
    requestListening: true,
    metadata: { provider: "stt" }
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(published.map((event) => event.state), ["wake_detected", "listening"]);
  assert.equal(published[1].activationId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(published[1].timeoutMs, 4_000);
  assert.deepEqual(requested, [{
    satelliteId: "sat-1",
    payload: {
      activationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      timeoutMs: 4_000,
      reason: "central_wake_word"
    }
  }]);
  assert.equal(sessions.snapshot("sat-1").state, "listening");
});

test("conserva una activación ante detecciones duplicadas", () => {
  const { coordinator, published } = fixture();
  const first = coordinator.activate("sat-1", { reason: "local_wake_word", timeoutMs: 4_000 });
  const duplicate = coordinator.activate("sat-1", { reason: "central_wake_word", timeoutMs: 4_000, requestListening: true });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.activationId, first.activationId);
  assert.equal(published.length, 2);
});

test("administra el ciclo processing, speaking, seguimiento e idle", () => {
  const { sessions, coordinator, published } = fixture();
  coordinator.activate("sat-1", { reason: "local_wake_word", timeoutMs: 4_000 });
  coordinator.processing("sat-1");
  coordinator.speaking("sat-1");
  coordinator.followUp("sat-1", { timeoutMs: 8_000 });
  coordinator.processing("sat-1", { reason: "follow_up_captured" });
  coordinator.complete("sat-1", "response_without_speech");
  assert.deepEqual(published.map((event) => event.state), [
    "wake_detected", "listening", "processing", "speaking",
    "follow_up_listening", "processing", "idle"
  ]);
  assert.equal(published.at(-1).activationId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(sessions.snapshot("sat-1").activationId, null);
});

test("una interrupción invalida la respuesta anterior y vuelve a escuchar", () => {
  const activationIds = ["activation-old", "activation-new"];
  const { sessions, coordinator, published } = fixture(() => activationIds.shift());
  coordinator.activate("sat-1", { reason: "stt_wake_word", timeoutMs: 4_000 });
  coordinator.processing("sat-1");
  coordinator.speaking("sat-1");
  const result = coordinator.interruptAndListen("sat-1", { timeoutMs: 7_000 });
  assert.equal(result.activationId, "activation-new");
  assert.equal(sessions.snapshot("sat-1").state, "listening");
  assert.deepEqual(published.slice(-2).map((event) => event.state), ["interrupted", "listening"]);
  assert.equal(published.at(-2).activationId, "activation-old");
  assert.equal(published.at(-1).activationId, "activation-new");
});

test("rechaza transiciones que no pertenecen al ciclo", () => {
  const { coordinator } = fixture();
  coordinator.activate("sat-1", { reason: "local_wake_word", timeoutMs: 4_000 });
  assert.throws(
    () => coordinator.transition("sat-1", "follow_up_listening"),
    /Transición de voz inválida/
  );
});

test("el timeout autoritativo devuelve la sesión a idle", async () => {
  const { sessions, coordinator, published } = fixture();
  coordinator.activate("sat-1", { reason: "manual_request", timeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(sessions.snapshot("sat-1").state, "idle");
  assert.equal(published.at(-1).reason, "listening_timeout");
  coordinator.close();
});

test("renueva el timeout cuando STT ya reconoció un comando parcial", async () => {
  const { sessions, coordinator, published } = fixture();
  coordinator.activate("sat-1", { reason: "stt_wake_word", timeoutMs: 8 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  coordinator.refreshListening("sat-1", { timeoutMs: 20, reason: "stt_partial_command" });
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(sessions.snapshot("sat-1").state, "listening");
  assert.equal(published.at(-1).reason, "stt_partial_command");
  await new Promise((resolve) => setTimeout(resolve, 18));
  assert.equal(sessions.snapshot("sat-1").state, "idle");
  coordinator.close();
});

test("ignora el cierre de un socket que aún no tiene satelliteId", () => {
  const { coordinator } = fixture();

  assert.equal(coordinator.remove(undefined), false);
  assert.equal(coordinator.remove(""), false);
});

test("solicita una escucha sin instrucciones de captura local", () => {
  const { coordinator, requested } = fixture();
  coordinator.activate("sat-1", {
    reason: "central_wake_word",
    timeoutMs: 4_000
  });
  coordinator.processing("sat-1");
  coordinator.followUp("sat-1", {
    timeoutMs: 8_000,
    reason: "wake_word_only",
    requestListening: true
  });
  assert.equal(requested.length, 1);
  assert.equal("captureMode" in requested[0].payload, false);
  assert.equal(requested[0].payload.reason, "wake_word_only");
});
