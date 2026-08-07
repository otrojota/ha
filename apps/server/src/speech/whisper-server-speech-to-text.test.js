import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { WhisperServerSpeechToText } from "./whisper-server-speech-to-text.js";

test("envía WAV al servidor persistente y devuelve su texto", async () => {
  const requests = [];
  const provider = new WhisperServerSpeechToText({
    modelPath: "/models/large.bin",
    managed: false,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (!options.method) return new Response("ok");
      return Response.json({ text: "hola mundo" });
    }
  });
  await provider.initialize();
  assert.equal(await provider.transcribe(Buffer.from("wav")), "hola mundo");
  assert.equal(requests[1].url, "http://127.0.0.1:8178/inference");
  assert.equal(requests[1].options.method, "POST");
});

test("falla claramente si el servidor externo no está disponible", async () => {
  const provider = new WhisperServerSpeechToText({
    modelPath: "/models/large.bin",
    managed: false,
    fetchImpl: async () => { throw new Error("sin conexión"); }
  });
  await assert.rejects(provider.initialize(), /no responde/);
});

test("inicia whisper-server con hilos y best-of configurables", async () => {
  let spawned;
  let ready = false;
  const child = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => {}
  });
  const provider = new WhisperServerSpeechToText({
    modelPath: "/models/large-v3.bin",
    threads: 8,
    bestOf: 1,
    spawnImpl: (executable, args) => {
      spawned = { executable, args };
      ready = true;
      return child;
    },
    fetchImpl: async () => {
      if (!ready) throw new Error("todavía no");
      return new Response("ok");
    }
  });
  await provider.initialize();
  assert.equal(spawned.executable, "whisper-server");
  assert.deepEqual(spawned.args.slice(0, 10), [
    "-m", "/models/large-v3.bin",
    "-l", "es",
    "-t", "8",
    "-bo", "1",
    "--host", "127.0.0.1"
  ]);
  provider.close();
});
