import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AudioDeviceProvider, normalizeDevice } from "./audio-device-provider.js";

const execFileAsync = promisify(execFile);

export class PipeWireAudioDeviceProvider extends AudioDeviceProvider {
  constructor() {
    super("pipewire");
  }

  async list(kind) {
    const pactlKind = kind === "input" ? "sources" : "sinks";
    const { stdout } = await execFileAsync("pactl", ["-f", "json", "list", pactlKind], { timeout: 3000 });
    return JSON.parse(stdout)
      .filter((device) => kind !== "input" || !device.name?.endsWith(".monitor"))
      .map((device) => normalizeDevice(
        device.name,
        device.description || device.properties?.["device.description"] || device.name,
        { available: device.state !== "SUSPENDED", backend: this.name }
      ));
  }

  listInputDevices() {
    return this.list("input");
  }

  listOutputDevices() {
    return this.list("output");
  }

  async listInputChannels(deviceId) {
    const { stdout } = await execFileAsync("pactl", ["-f", "json", "list", "sources"], { timeout: 3000 });
    const device = JSON.parse(stdout).find((source) => source.name === deviceId);
    if (!device) throw new Error("Dispositivo de entrada no encontrado");
    const names = Array.isArray(device.channel_map)
      ? device.channel_map
      : String(device.channel_map || "").split(",").map((name) => name.trim()).filter(Boolean);
    const count = names.length || Number(String(device.sample_spec || "").match(/(\d+)ch/)?.[1]) || 1;
    return Array.from({ length: count }, (_, id) => ({
      id,
      name: names[id] ? `Canal ${id + 1} · ${names[id]}` : `Canal ${id + 1}`
    }));
  }
}
