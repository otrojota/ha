import assert from "node:assert/strict";
import test from "node:test";
import { createStreamingTtsProvider } from "./index.js";
import { KokoroStreamingTts, splitForStreaming } from "./kokoro-streaming-tts.js";

test("Kokoro es el único motor TTS construido por el servidor", () => {
  assert.ok(createStreamingTtsProvider() instanceof KokoroStreamingTts);
});

test("divide textos largos en segmentos aptos para streaming", () => {
  const segments = splitForStreaming("Primera oración. Segunda oración bastante más larga. Tercera.", 35);
  assert.deepEqual(segments, ["Primera oración.", "Segunda oración bastante más larga.", "Tercera."]);
  assert.ok(segments.every((segment) => segment.length <= 35));
});

test("publica las voces oficiales de Kokoro en español y sus mezclas", async () => {
  const provider = new KokoroStreamingTts({ pythonExecutable: "python" });
  provider.initialize = async () => {};
  assert.deepEqual((await provider.listVoices()).map((voice) => voice.id), [
    "ef_dora",
    "em_alex",
    "em_santa",
    "ef_dora,em_alex",
    "ef_dora,em_santa",
    "em_alex,em_santa"
  ]);
  assert.ok((await provider.listVoices()).every((voice) => voice.sampleRate === 24000));
});
