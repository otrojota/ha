import test from "node:test";
import assert from "node:assert/strict";
import { PcmPlaybackQueue } from "./playback-worklet.js";

function pcm16(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return buffer;
}

test("PcmPlaybackQueue remuestrea PCM mono sin bloquear la hebra principal", () => {
  const queue = new PcmPlaybackQueue({ outputSampleRate: 48_000 });
  queue.start({ streamId: "stream", sampleRate: 16_000, channels: 1 });
  queue.append(pcm16(new Array(640).fill(8192)));
  const output = new Float32Array(128);
  assert.equal(queue.pull(output), null);
  assert.ok(output.every((sample) => Math.abs(sample - 0.25) < 0.001));
});

test("PcmPlaybackQueue mezcla TTS multicanal a mono", () => {
  const queue = new PcmPlaybackQueue({ outputSampleRate: 16_000 });
  queue.start({ streamId: "stream", sampleRate: 16_000, channels: 2 });
  const interleaved = [];
  for (let index = 0; index < 640; index += 1) interleaved.push(16384, 0);
  queue.append(pcm16(interleaved));
  const output = new Float32Array(128);
  queue.pull(output);
  assert.ok(output.every((sample) => Math.abs(sample - 0.25) < 0.001));
});

