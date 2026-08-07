import test from "node:test";
import assert from "node:assert/strict";
import { StreamingPcm16Framer } from "./capture-worklet.js";

test("StreamingPcm16Framer convierte 48 kHz a frames PCM de 20 ms a 16 kHz", () => {
  const framer = new StreamingPcm16Framer({ inputSampleRate: 48_000 });
  const frames = [];
  framer.push(new Float32Array(960).fill(0.5), (frame, index) => frames.push({ frame, index }));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].frame.length, 320);
  assert.equal(frames[0].index, 0);
  assert.ok(frames[0].frame.every((sample) => Math.abs(sample - 16384) <= 1));
});

test("StreamingPcm16Framer conserva estado entre quantums pequeños", () => {
  const framer = new StreamingPcm16Framer({ inputSampleRate: 16_000 });
  const frames = [];
  for (let index = 0; index < 5; index += 1) {
    framer.push(new Float32Array(64).fill(-0.25), (frame) => frames.push(frame));
  }
  assert.equal(frames.length, 1);
  assert.equal(frames[0][0], -8192);
});

