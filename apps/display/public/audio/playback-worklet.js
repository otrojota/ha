const WorkletBase = globalThis.AudioWorkletProcessor || class {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
};

export class PcmPlaybackQueue {
  constructor({ outputSampleRate } = {}) {
    this.outputSampleRate = Number(outputSampleRate) || 48_000;
    this.reset();
  }

  reset() {
    this.streamId = null;
    this.inputSampleRate = 24_000;
    this.channels = 1;
    this.queue = [];
    this.queueOffset = 0;
    this.queuedSamples = 0;
    this.phase = 0;
    this.current = null;
    this.next = null;
    this.ending = false;
    this.failed = false;
    this.started = false;
  }

  start({ streamId, sampleRate, channels = 1 }) {
    this.reset();
    this.streamId = streamId;
    this.inputSampleRate = Number(sampleRate) || 24_000;
    this.channels = Math.max(1, Number(channels) || 1);
  }

  append(buffer) {
    if (!this.streamId || !(buffer instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(buffer);
    const samples = new Float32Array(Math.floor(bytes.byteLength / 2 / this.channels));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let output = 0; output < samples.length; output += 1) {
      let sum = 0;
      for (let channel = 0; channel < this.channels; channel += 1) {
        sum += view.getInt16((output * this.channels + channel) * 2, true) / 32768;
      }
      samples[output] = sum / this.channels;
    }
    if (samples.length) {
      this.queue.push(samples);
      this.queuedSamples += samples.length;
    }
  }

  end({ failed = false } = {}) {
    this.ending = true;
    this.failed = failed;
  }

  pull(output) {
    if (!this.streamId) {
      output.fill(0);
      return null;
    }
    const prebuffer = Math.max(1, Math.round(this.inputSampleRate * 0.04));
    if (!this.started && this.queuedSamples < prebuffer && !this.ending) {
      output.fill(0);
      return null;
    }
    this.started = true;
    if (this.current === null) this.current = this.#readSample();
    if (this.next === null) this.next = this.#readSample();
    const step = this.inputSampleRate / this.outputSampleRate;
    for (let index = 0; index < output.length; index += 1) {
      if (this.current === null || this.next === null) {
        output[index] = 0;
        continue;
      }
      output[index] = this.current + (this.next - this.current) * this.phase;
      this.phase += step;
      while (this.phase >= 1) {
        this.phase -= 1;
        this.current = this.next;
        this.next = this.#readSample();
        if (this.next === null) break;
      }
    }
    if (this.ending && this.queuedSamples === 0 && this.next === null) {
      const result = { streamId: this.streamId, failed: this.failed };
      this.reset();
      return result;
    }
    return null;
  }

  #readSample() {
    while (this.queue.length) {
      const chunk = this.queue[0];
      if (this.queueOffset < chunk.length) {
        const sample = chunk[this.queueOffset];
        this.queueOffset += 1;
        this.queuedSamples -= 1;
        return sample;
      }
      this.queue.shift();
      this.queueOffset = 0;
    }
    return null;
  }
}

export class VoicePlaybackProcessor extends WorkletBase {
  constructor() {
    super();
    this.transportPort = null;
    this.queue = new PcmPlaybackQueue({ outputSampleRate: globalThis.sampleRate });
    this.port.onmessage = ({ data }) => {
      if (data?.type === "transport.port" && data.port) {
        this.transportPort = data.port;
        this.transportPort.onmessage = (event) => this.#handle(event.data);
        this.transportPort.start?.();
      } else this.#handle(data);
    };
  }

  #handle(message) {
    if (message?.type === "playback.start") this.queue.start(message);
    if (message?.type === "playback.chunk") this.queue.append(message.audio);
    if (message?.type === "playback.end") this.queue.end(message);
    if (message?.type === "playback.abort") {
      const streamId = this.queue.streamId;
      this.queue.reset();
      if (streamId) this.transportPort?.postMessage({ type: "playback.ended", streamId, failed: true, reason: message.reason || "aborted" });
    }
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    if (!channels?.length) return true;
    const ended = this.queue.pull(channels[0]);
    for (let channel = 1; channel < channels.length; channel += 1) channels[channel].set(channels[0]);
    if (ended) this.transportPort?.postMessage({ type: "playback.ended", ...ended });
    return true;
  }
}

if (typeof globalThis.registerProcessor === "function") globalThis.registerProcessor("voice-playback", VoicePlaybackProcessor);

