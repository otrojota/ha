import {
  VOICE_INPUT_FRAME_DURATION_MS,
  VOICE_INPUT_FRAME_SAMPLES,
  VOICE_INPUT_SAMPLE_RATE
} from "./browser-audio-protocol.js";

const WorkletBase = globalThis.AudioWorkletProcessor || class {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
};

export class StreamingPcm16Framer {
  constructor({ inputSampleRate, targetSampleRate = VOICE_INPUT_SAMPLE_RATE, frameSamples = VOICE_INPUT_FRAME_SAMPLES } = {}) {
    this.inputSampleRate = Number(inputSampleRate) || targetSampleRate;
    this.targetSampleRate = targetSampleRate;
    this.frameSamples = frameSamples;
    this.step = this.inputSampleRate / this.targetSampleRate;
    this.nextOutputPosition = 0;
    this.inputPosition = 0;
    this.previousSample = null;
    this.frame = new Int16Array(frameSamples);
    this.frameOffset = 0;
    this.frameIndex = 0;
  }

  push(samples, emit) {
    for (let index = 0; index < samples.length; index += 1) {
      const current = Number.isFinite(samples[index]) ? samples[index] : 0;
      if (this.previousSample === null) {
        this.previousSample = current;
        this.#emitSample(current, emit);
        this.nextOutputPosition += this.step;
        this.inputPosition = 1;
        continue;
      }
      while (this.nextOutputPosition <= this.inputPosition) {
        const fraction = this.nextOutputPosition - (this.inputPosition - 1);
        this.#emitSample(this.previousSample + (current - this.previousSample) * fraction, emit);
        this.nextOutputPosition += this.step;
      }
      this.previousSample = current;
      this.inputPosition += 1;
    }
  }

  #emitSample(sample, emit) {
    const clipped = Math.max(-1, Math.min(1, sample));
    this.frame[this.frameOffset] = clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767);
    this.frameOffset += 1;
    if (this.frameOffset !== this.frameSamples) return;
    const completed = this.frame;
    this.frame = new Int16Array(this.frameSamples);
    this.frameOffset = 0;
    emit(completed, this.frameIndex);
    this.frameIndex += 1;
  }
}

export class VoiceCaptureProcessor extends WorkletBase {
  constructor(options = {}) {
    super();
    const processorOptions = options.processorOptions || {};
    this.channel = Math.max(0, Number(processorOptions.channel) || 0);
    this.transportPort = null;
    this.levelSquares = 0;
    this.levelSamples = 0;
    this.levelPeak = 0;
    this.framer = new StreamingPcm16Framer({ inputSampleRate: globalThis.sampleRate || processorOptions.inputSampleRate });
    this.port.onmessage = ({ data }) => {
      if (data?.type === "transport.port" && data.port) {
        this.transportPort = data.port;
        this.transportPort.start?.();
      }
      if (data?.type === "capture.channel") this.channel = Math.max(0, Number(data.channel) || 0);
    };
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const samples = channels[Math.min(this.channel, channels.length - 1)] || channels[0];
    this.framer.push(samples, (frame) => this.#emitFrame(frame));
    return true;
  }

  #emitFrame(frame) {
    for (let index = 0; index < frame.length; index += 1) {
      const normalized = frame[index] / 32768;
      this.levelSquares += normalized * normalized;
      this.levelPeak = Math.max(this.levelPeak, Math.abs(frame[index]));
    }
    this.levelSamples += frame.length;
    const audio = frame.buffer;
    this.transportPort?.postMessage({
      type: "capture.frame",
      capturedAtMs: Math.max(0, Math.round(Date.now() - VOICE_INPUT_FRAME_DURATION_MS)),
      audio
    }, [audio]);
    if (this.levelSamples < VOICE_INPUT_SAMPLE_RATE / 10) return;
    const rms = Math.sqrt(this.levelSquares / this.levelSamples);
    const db = rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
    this.transportPort?.postMessage({
      type: "capture.level",
      db: Number(db.toFixed(1)),
      level: Math.min(1, Math.max(0, (db + 60) / 60)),
      clipping: this.levelPeak >= 32760
    });
    this.levelSquares = 0;
    this.levelSamples = 0;
    this.levelPeak = 0;
  }
}

if (typeof globalThis.registerProcessor === "function") globalThis.registerProcessor("voice-capture", VoiceCaptureProcessor);
