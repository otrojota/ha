const AUDIO_STORAGE_KEY = "ha.browser-audio.config.v1";

function unavailableMediaDevicesError() {
  return new Error("Chrome bloqueó los dispositivos de audio porque esta página usa HTTP. Ábrela mediante HTTPS.");
}

function readStoredAudioConfig() {
  try {
    return { inputDeviceId: null, outputDeviceId: null, inputChannel: 0, ...JSON.parse(localStorage.getItem(AUDIO_STORAGE_KEY) || "{}") };
  } catch {
    return { inputDeviceId: null, outputDeviceId: null, inputChannel: 0 };
  }
}

export class BrowserAudioController extends EventTarget {
  constructor() {
    super();
    this.config = readStoredAudioConfig();
    this.worker = null;
    this.stream = null;
    this.captureContext = null;
    this.playbackContext = null;
    this.captureNode = null;
    this.playbackNode = null;
    this.sourceNode = null;
    this.silentGain = null;
    this.started = false;
  }

  async start(configuration) {
    if (!navigator.mediaDevices?.getUserMedia) throw unavailableMediaDevicesError();
    if (!globalThis.AudioWorkletNode || !globalThis.Worker) {
      throw new Error("Este Chromium no ofrece las APIs de audio requeridas");
    }
    await this.stop();
    this.worker = new Worker(new URL("./voice-transport.worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => this.dispatchEvent(new CustomEvent(data.type, { detail: data }));
    this.worker.onerror = (event) => this.dispatchEvent(new CustomEvent("error", { detail: { message: event.message } }));

    const constraints = {
      channelCount: { ideal: Math.max(1, this.config.inputChannel + 1) },
      sampleRate: { ideal: 16_000 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false
    };
    if (this.config.inputDeviceId) constraints.deviceId = { exact: this.config.inputDeviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    this.captureContext = new AudioContext({ sampleRate: 16_000, latencyHint: "interactive" });
    this.playbackContext = new AudioContext({ latencyHint: "interactive" });
    await Promise.all([
      this.captureContext.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url)),
      this.playbackContext.audioWorklet.addModule(new URL("./playback-worklet.js", import.meta.url))
    ]);
    this.sourceNode = this.captureContext.createMediaStreamSource(this.stream);
    this.captureNode = new AudioWorkletNode(this.captureContext, "voice-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        channel: this.config.inputChannel,
        inputSampleRate: this.captureContext.sampleRate
      }
    });
    this.silentGain = this.captureContext.createGain();
    this.silentGain.gain.value = 0;
    this.sourceNode.connect(this.captureNode).connect(this.silentGain).connect(this.captureContext.destination);

    this.playbackNode = new AudioWorkletNode(this.playbackContext, "voice-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });
    this.playbackNode.connect(this.playbackContext.destination);
    if (this.config.outputDeviceId && typeof this.playbackContext.setSinkId === "function") {
      await this.playbackContext.setSinkId(this.config.outputDeviceId);
    }

    const captureChannel = new MessageChannel();
    this.captureNode.port.postMessage({ type: "transport.port", port: captureChannel.port1 }, [captureChannel.port1]);
    this.worker.postMessage({ type: "capture.port", port: captureChannel.port2 }, [captureChannel.port2]);
    const playbackChannel = new MessageChannel();
    this.playbackNode.port.postMessage({ type: "transport.port", port: playbackChannel.port1 }, [playbackChannel.port1]);
    this.worker.postMessage({ type: "playback.port", port: playbackChannel.port2 }, [playbackChannel.port2]);

    await Promise.allSettled([this.captureContext.resume(), this.playbackContext.resume()]);
    this.worker.postMessage({ type: "configure", configuration });
    this.started = true;
    return this.snapshot();
  }

  async resume() {
    await Promise.allSettled([this.captureContext?.resume(), this.playbackContext?.resume()]);
  }

  async stop() {
    this.started = false;
    this.worker?.postMessage({ type: "disconnect", reason: "browser_audio_stopped" });
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.sourceNode?.disconnect();
    this.captureNode?.disconnect();
    this.playbackNode?.disconnect();
    await Promise.allSettled([this.captureContext?.close(), this.playbackContext?.close()]);
    this.captureContext = null;
    this.playbackContext = null;
  }

  sendEvent(eventType, payload = {}) {
    this.worker?.postMessage({ type: "event.send", eventType, payload });
  }

  configureWakeWord(wakeWord) {
    this.worker?.postMessage({ type: "wake-word.configure", wakeWord });
  }

  async configure(update) {
    this.config = { ...this.config, ...update };
    localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(this.config));
    return this.config;
  }

  async devices({ requestPermission = false } = {}) {
    if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
      throw unavailableMediaDevicesError();
    }
    if (requestPermission && !this.stream) {
      const permission = await navigator.mediaDevices.getUserMedia({ audio: true });
      permission.getTracks().forEach((track) => track.stop());
    }
    const listed = await navigator.mediaDevices.enumerateDevices();
    const map = (kind) => listed.filter((device) => device.kind === kind).map((device, index) => ({
      id: device.deviceId,
      name: device.label || `${kind === "audioinput" ? "Micrófono" : "Salida"} ${index + 1}`,
      available: true,
      groupId: device.groupId
    }));
    return { input: map("audioinput"), output: map("audiooutput") };
  }

  async inputChannels(deviceId) {
    const constraints = { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: { ideal: 8 } };
    const probe = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    try {
      const track = probe.getAudioTracks()[0];
      const capabilities = track.getCapabilities?.();
      const settings = track.getSettings?.();
      const maximum = Math.max(1, Number(capabilities?.channelCount?.max || settings?.channelCount || 1));
      return Array.from({ length: maximum }, (_, id) => ({ id, name: `Canal ${id + 1}` }));
    } finally {
      probe.getTracks().forEach((track) => track.stop());
    }
  }

  snapshot() {
    const track = this.stream?.getAudioTracks()[0];
    return {
      started: this.started,
      config: { ...this.config },
      captureSampleRate: this.captureContext?.sampleRate || null,
      playbackSampleRate: this.playbackContext?.sampleRate || null,
      trackSettings: track?.getSettings?.() || null
    };
  }
}
