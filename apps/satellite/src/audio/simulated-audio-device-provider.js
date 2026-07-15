import { AudioDeviceProvider, normalizeDevice } from "./audio-device-provider.js";

export class SimulatedAudioDeviceProvider extends AudioDeviceProvider {
  constructor() {
    super("simulated");
  }

  async listInputDevices() {
    return [normalizeDevice("simulated-input-default", "Micrófono simulado", { simulated: true, backend: this.name })];
  }

  async listOutputDevices() {
    return [normalizeDevice("simulated-output-default", "Altavoz simulado (TTS)", { simulated: true, backend: this.name })];
  }

  async listInputChannels() {
    return [{ id: 0, name: "Canal 1" }];
  }
}
