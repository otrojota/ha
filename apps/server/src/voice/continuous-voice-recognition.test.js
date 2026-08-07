import assert from "node:assert/strict";
import test from "node:test";
import { ContinuousVoiceRecognitionService, containsInterruption, findWakeWord } from "./continuous-voice-recognition.js";

function pcm(amplitude) {
  const frame = Buffer.alloc(640);
  for (let offset = 0; offset < frame.length; offset += 2) frame.writeInt16LE(amplitude, offset);
  return frame;
}

const loud = pcm(8_000);
const quiet = pcm(0);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function fixture({ transcripts, initialState = "idle", partialIntervalMs = 10_000 } = {}) {
  const session = {
    state: initialState,
    activationId: initialState === "idle" ? null : "activation-1",
    readRecentAudio: () => Buffer.concat([loud, loud])
  };
  const partials = [];
  const commands = [];
  const interruptions = [];
  const refreshed = [];
  const service = new ContinuousVoiceRecognitionService({
    speechToText: { transcribe: async () => transcripts.shift() || "" },
    sessionProvider: () => session,
    voiceStates: {
      activate: () => {
        session.state = "listening";
        session.activationId = "activation-1";
        return { accepted: true, activationId: session.activationId };
      },
      refreshListening: (satelliteId, options) => refreshed.push({ satelliteId, options })
    },
    onPartial: (details) => partials.push(details),
    onCommand: (details) => commands.push(details),
    onInterrupt: (details) => interruptions.push(details),
    initialNoiseFloorDb: -50,
    minimumSpeechMs: 120,
    silenceDurationMs: 120,
    partialMinimumMs: 120,
    partialIntervalMs
  });
  service.configure("sat-1", { enabled: true, wakeWord: "Pantallita" });
  const push = (audio) => service.accept("sat-1", session, {
    accepted: true,
    bufferReset: false,
    frame: { audio }
  });
  return { service, session, partials, commands, interruptions, refreshed, push };
}

test("encuentra una wake word española dentro de una frase", () => {
  assert.deepEqual(findWakeWord("Hola, Pantallita, qué hora es", "Pantallita"), {
    found: true,
    command: "qué hora es"
  });
  assert.equal(containsInterruption("por favor, detente ahora"), true);
});

test("el mismo STT activa y entrega lo posterior a la wake word como comando", async () => {
  const context = fixture({ transcripts: ["Pantallita, qué hora es"] });
  for (let index = 0; index < 6; index += 1) context.push(loud);
  for (let index = 0; index < 6; index += 1) context.push(quiet);
  await settle();
  assert.equal(context.session.state, "listening");
  assert.equal(context.commands.length, 1);
  assert.equal(context.commands[0].transcript, "qué hora es");
  assert.equal(context.partials.at(-1).final, true);
});

test("publica parciales antes de cerrar el comando por pausa", async () => {
  const context = fixture({
    transcripts: ["Pantallita qué", "Pantallita qué hora es"],
    partialIntervalMs: 120
  });
  for (let index = 0; index < 12; index += 1) context.push(loud);
  for (let index = 0; index < 6; index += 1) context.push(quiet);
  await settle();
  assert.equal(context.partials.some((item) => item.final === false), true);
  assert.equal(context.commands.at(-1).transcript, "qué hora es");
});

test("conserva el comando parcial si la transcripción final pierde la wake word", async () => {
  const context = fixture({
    transcripts: ["Pantallita qué hora es", "Gracias"],
    partialIntervalMs: 120
  });
  for (let index = 0; index < 12; index += 1) context.push(loud);
  for (let index = 0; index < 6; index += 1) context.push(quiet);
  await settle();
  assert.equal(context.commands.length, 1);
  assert.equal(context.commands[0].transcript, "qué hora es");
  assert.equal(context.partials.at(-1).text, "qué hora es");
  assert.equal(context.partials.at(-1).final, true);
});

test("conserva y da tiempo al comando parcial posterior a la wake word", async () => {
  const context = fixture({
    transcripts: ["toca la radio Valentín Letelier", "Gracias"],
    initialState: "listening",
    partialIntervalMs: 120
  });
  for (let index = 0; index < 12; index += 1) context.push(loud);
  for (let index = 0; index < 6; index += 1) context.push(quiet);
  await settle();
  assert.equal(context.commands.length, 1);
  assert.equal(context.commands[0].transcript, "toca la radio Valentín Letelier");
  assert.equal(context.partials.at(-1).text, "toca la radio Valentín Letelier");
  assert.equal(context.refreshed.length > 0, true);
});

test("reconoce detente durante TTS sin convertirlo en comando", async () => {
  const context = fixture({ transcripts: ["detente"], initialState: "speaking" });
  for (let index = 0; index < 6; index += 1) context.push(loud);
  for (let index = 0; index < 6; index += 1) context.push(quiet);
  await settle();
  assert.equal(context.interruptions.length, 1);
  assert.equal(context.commands.length, 0);
});

test("conserva las palabras de interrupción como parte del comando mientras escucha", async () => {
  for (const transcript of [
    "toca Stop de Spice Girls",
    "reproduce Alto de la lista",
    "busca la canción Detente"
  ]) {
    const context = fixture({ transcripts: [transcript], initialState: "listening" });
    for (let index = 0; index < 6; index += 1) context.push(loud);
    for (let index = 0; index < 6; index += 1) context.push(quiet);
    await settle();
    assert.equal(context.interruptions.length, 0);
    assert.equal(context.commands.length, 1);
    assert.equal(context.commands[0].transcript, transcript);
  }
});
