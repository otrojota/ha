import test from "node:test";
import assert from "node:assert/strict";
import { decodeVoiceInputFrame } from "../../../../packages/contracts/src/index.js";
import { decodeAudioFrame, encodeVoiceInputFrame, VOICE_INPUT_FRAME_BYTES } from "./browser-audio-protocol.js";

test("encodeVoiceInputFrame produce HAI1 compatible con el contrato del servidor", () => {
  const streamId = "12345678-1234-4123-8123-123456789abc";
  const audio = new Uint8Array(VOICE_INPUT_FRAME_BYTES);
  audio[0] = 0x34;
  audio[1] = 0x12;
  const encoded = encodeVoiceInputFrame(streamId, 7, 1_725_000_000_123, audio);
  const decoded = decodeVoiceInputFrame(Buffer.from(encoded));
  assert.equal(decoded.streamId, streamId);
  assert.equal(decoded.sequence, 7);
  assert.equal(decoded.capturedAtMs, 1_725_000_000_123);
  assert.deepEqual([...decoded.audio.subarray(0, 2)], [0x34, 0x12]);
});

test("decodeAudioFrame separa la cabecera HAT1 del PCM", () => {
  const streamId = "12345678-1234-4123-8123-123456789abc";
  const frame = Buffer.alloc(48);
  frame.write("HAT1", 0, "ascii");
  frame.write(streamId, 4, "ascii");
  frame.writeUInt32BE(9, 40);
  frame.writeInt16LE(1234, 44);
  frame.writeInt16LE(-1234, 46);
  const decoded = decodeAudioFrame(frame);
  assert.equal(decoded.streamId, streamId);
  assert.equal(decoded.sequence, 9);
  assert.deepEqual([...new Uint8Array(decoded.audio)], [...frame.subarray(44)]);
});

