import assert from "node:assert/strict";
import test from "node:test";
import { decodeAudioFrame } from "@ha/contracts";
import { TtsStreamService } from "./tts-stream-service.js";

test("envía control JSON y PCM sólo al socket del satélite", async () => {
  const sent = [];
  const started = [];
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, send(data) { sent.push(data); } };
  const service = new TtsStreamService({
    provider: {
      name: "test",
      async listVoices() { return [{ id: "voz", sampleRate: 16000 }]; },
      async *synthesize() { yield Buffer.from([1, 2]); yield Buffer.from([3, 4]); }
    },
    voiceConfig: { voiceFor: () => "voz" },
    sockets: { get: (id) => id === "cocina" ? socket : null },
    onStreamStarted: (details) => started.push(details)
  });
  const result = await service.speak("hola", "cocina", { activationId: "activation-1" });
  assert.equal(result.chunks, 2);
  assert.equal(JSON.parse(sent[0]).type, "assistant.speech.stream.started");
  assert.equal(JSON.parse(sent[0]).payload.activationId, "activation-1");
  assert.equal(started[0].activationId, "activation-1");
  assert.deepEqual(decodeAudioFrame(sent[1]).audio, Buffer.from([1, 2]));
  assert.equal(decodeAudioFrame(sent[2]).sequence, 1);
  assert.equal(JSON.parse(sent[3]).type, "assistant.speech.stream.ended");
});
