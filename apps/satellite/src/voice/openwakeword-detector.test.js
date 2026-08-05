import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { OpenWakeWordDetector } from "./openwakeword-detector.js";

function fakeProcess({ onKill = () => {} } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    onKill(signal, child);
    return true;
  };
  return child;
}

test("adjunta a la detección un WAV con el audio reciente", async () => {
  const child = fakeProcess();
  let detection;
  const detector = new OpenWakeWordDetector({
    python: "python",
    scriptPath: "detector.py",
    modelPath: "model.onnx",
    melspectrogramPath: "melspectrogram.onnx",
    embeddingPath: "embedding.onnx",
    wakeWord: "Pantallita",
    activationAudioSeconds: 1,
    spawnProcess: () => child,
    onDetected: (value) => { detection = value; },
    log: () => {}
  });
  const started = detector.start();
  child.stdout.write('{"type":"ready"}\n');
  await started;
  detector.write(Buffer.alloc(40_000, 7));
  child.stdout.write('{"type":"detected","score":0.999}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detection.score, 0.999);
  assert.equal(detection.audio.subarray(0, 4).toString(), "RIFF");
  assert.equal(detection.audio.readUInt32LE(24), 16_000);
  assert.equal(detection.audio.readUInt32LE(40), 32_000);
  assert.equal(detection.audio.length, 44 + 32_000);
  detector.stop();
});

test("reinicia el contexto Python y descarta el audio anterior", async () => {
  const child = fakeProcess({
    onKill: (signal, process) => {
      if (signal === "SIGUSR1") queueMicrotask(() => process.stdout.write('{"type":"reset"}\n'));
    }
  });
  let detection;
  const detector = new OpenWakeWordDetector({
    python: "python",
    scriptPath: "detector.py",
    modelPath: "model.onnx",
    melspectrogramPath: "melspectrogram.onnx",
    embeddingPath: "embedding.onnx",
    wakeWord: "Pantallita",
    spawnProcess: () => child,
    onDetected: (value) => { detection = value; },
    log: () => {}
  });
  const started = detector.start();
  child.stdout.write('{"type":"ready"}\n');
  await started;
  detector.write(Buffer.alloc(10_000, 3));
  await detector.reset();
  detector.write(Buffer.alloc(1_280, 4));
  child.stdout.write('{"type":"detected","score":0.999}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detection.audio.readUInt32LE(40), 1_280);
  detector.stop();
});

test("configura filtro acústico y exige dos frames por defecto", async () => {
  const child = fakeProcess();
  let spawnedArgs;
  const detector = new OpenWakeWordDetector({
    python: "python",
    scriptPath: "detector.py",
    modelPath: "model.onnx",
    melspectrogramPath: "melspectrogram.onnx",
    embeddingPath: "embedding.onnx",
    wakeWord: "Pantallita",
    spawnProcess: (_command, args) => {
      spawnedArgs = args;
      return child;
    },
    onDetected: () => {},
    log: () => {}
  });
  const started = detector.start();
  child.stdout.write('{"type":"ready"}\n');
  await started;
  assert.deepEqual(spawnedArgs.slice(-8), [
    "--threshold", "0.8",
    "--patience", "2",
    "--cooldown-ms", "2000",
    "--minimum-audio-db", "-55",
    "--audio-activity-window-ms", "1000"
  ].slice(-8));
  assert.equal(spawnedArgs.at(-2), "--audio-activity-window-ms");
  assert.equal(spawnedArgs.at(-1), "1000");
  detector.stop();
});
