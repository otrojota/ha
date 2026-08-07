import assert from "node:assert/strict";
import test from "node:test";
import { pcm16MonoToWav, pcmLevelDb } from "./pcm-audio.js";

test("genera WAV PCM mono de 16 kHz", () => {
  const wav = pcm16MonoToWav(Buffer.alloc(640));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 640);
});

test("calcula el nivel PCM sin salir del rango esperado", () => {
  assert.equal(pcmLevelDb(Buffer.alloc(640)), -60);
  const audio = Buffer.alloc(640);
  for (let offset = 0; offset < audio.length; offset += 2) audio.writeInt16LE(16_384, offset);
  assert.ok(pcmLevelDb(audio) > -7 && pcmLevelDb(audio) < -5);
});
