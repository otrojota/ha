import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveVoiceActivityDetector, VoiceCapture, pcmToWav } from "./voice-capture.js";

test("genera un WAV PCM mono de 16 kHz válido", () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
  const wav = pcmToWav(pcm);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("el VAD sensible de comandos acepta una orden corta de 100 ms", () => {
  const detector = new AdaptiveVoiceActivityDetector({
    initialNoiseFloorDb: -50,
    startMarginDb: 6,
    minimumSpeechMs: 100,
    calibrationFrames: 1
  });
  assert.equal(detector.process(-35, 50).speechStarted, false);
  assert.equal(detector.process(-35, 50).speechStarted, true);
});

test("desarma por completo una ventana de comando interrumpida", () => {
  const capture = new VoiceCapture({
    readConfig: async () => ({}),
    onPhrase: async () => {},
    log: () => {}
  });
  capture.arm(8_000, { bridgeCurrentPhrase: true });
  capture.disarm();
  assert.equal(capture.commandWindowMs, 0);
  assert.equal(capture.commandExpiresAt, 0);
  assert.equal(capture.bridgeCurrentPhrase, false);
});

test("puede detener y reiniciar la captura sin reutilizar el ciclo anterior", () => {
  const generations = [];
  const capture = new VoiceCapture({
    readConfig: async () => ({}),
    onPhrase: async () => {},
    log: () => {}
  });
  capture.loop = async (generation) => { generations.push(generation); };
  capture.start();
  capture.stop();
  capture.start();
  assert.deepEqual(generations, [1, 3]);
  assert.equal(capture.running, true);
  assert.equal(capture.paused, false);
});
