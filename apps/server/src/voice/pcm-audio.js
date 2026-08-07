import { VOICE_INPUT_SAMPLE_RATE } from "@ha/contracts";

export function pcm16MonoToWav(pcm, sampleRate = VOICE_INPUT_SAMPLE_RATE) {
  const audio = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + audio.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(audio.length, 40);
  return Buffer.concat([header, audio]);
}

export function pcmLevelDb(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2) return -60;
  let sumSquares = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    sumSquares += sample * sample;
    samples += 1;
  }
  if (!samples || !sumSquares) return -60;
  return Math.max(-60, 20 * Math.log10(Math.sqrt(sumSquares / samples) / 32768));
}
