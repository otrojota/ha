import { CoreAudioDeviceProvider } from "./coreaudio-device-provider.js";
import { PipeWireAudioDeviceProvider } from "./pipewire-audio-device-provider.js";
import { SimulatedAudioDeviceProvider } from "./simulated-audio-device-provider.js";

export function createAudioDeviceProvider(platform = process.platform) {
  if (platform === "darwin") return new CoreAudioDeviceProvider();
  if (platform === "linux") return new PipeWireAudioDeviceProvider();
  return new SimulatedAudioDeviceProvider();
}

export async function listAudioDevices(provider, onFallback = () => {}) {
  const simulated = new SimulatedAudioDeviceProvider();
  const list = async (kind) => {
    try {
      const devices = kind === "input" ? await provider.listInputDevices() : await provider.listOutputDevices();
      if (devices.length) return devices;
      throw new Error(`No se encontraron dispositivos de ${kind}`);
    } catch (error) {
      onFallback(kind, error);
      return kind === "input" ? simulated.listInputDevices() : simulated.listOutputDevices();
    }
  };

  const [input, output] = await Promise.all([list("input"), list("output")]);
  return { input, output, provider: provider.name };
}
