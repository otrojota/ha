export const PROTOCOL_VERSION = "5";
export const VOICE_INPUT_SAMPLE_RATE = 16_000;
export const VOICE_INPUT_CHANNELS = 1;
export const VOICE_INPUT_FRAME_DURATION_MS = 20;
export const VOICE_INPUT_FRAME_SAMPLES = 320;
export const VOICE_INPUT_FRAME_BYTES = 640;

const AUDIO_FRAME_MAGIC = "HAT1";
const AUDIO_FRAME_HEADER_BYTES = 44;
const VOICE_INPUT_FRAME_MAGIC = "HAI1";
const VOICE_INPUT_FRAME_HEADER_BYTES = 52;

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function readAscii(view, offset, length) {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(view.getUint8(offset + index));
  return value;
}

function requireStreamId(streamId) {
  const value = String(streamId || "");
  if (!/^[\x20-\x7e]{36}$/.test(value)) throw new Error("streamId debe tener 36 caracteres ASCII");
  return value;
}

export function createEvent(type, payload = {}, source = "browser") {
  return {
    id: crypto.randomUUID(),
    protocolVersion: PROTOCOL_VERSION,
    type,
    source,
    timestamp: new Date().toISOString(),
    payload
  };
}

export function encodeVoiceInputFrame(streamId, sequence, capturedAtMs, audio) {
  const id = requireStreamId(streamId);
  const pcm = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
  if (pcm.byteLength !== VOICE_INPUT_FRAME_BYTES) throw new Error(`El frame debe contener ${VOICE_INPUT_FRAME_BYTES} bytes`);
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new Error("sequence no es válido");
  if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0) throw new Error("capturedAtMs no es válido");
  const buffer = new ArrayBuffer(VOICE_INPUT_FRAME_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, VOICE_INPUT_FRAME_MAGIC);
  writeAscii(view, 4, id);
  view.setUint32(40, sequence, false);
  view.setBigUint64(44, BigInt(capturedAtMs), false);
  new Uint8Array(buffer, VOICE_INPUT_FRAME_HEADER_BYTES).set(pcm);
  return buffer;
}

export function decodeAudioFrame(data) {
  const buffer = data instanceof ArrayBuffer
    ? data
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const view = new DataView(buffer);
  if (buffer.byteLength < AUDIO_FRAME_HEADER_BYTES || readAscii(view, 0, 4) !== AUDIO_FRAME_MAGIC) {
    throw new Error("Frame TTS inválido");
  }
  return {
    streamId: readAscii(view, 4, 36),
    sequence: view.getUint32(40, false),
    audio: buffer.slice(AUDIO_FRAME_HEADER_BYTES)
  };
}

