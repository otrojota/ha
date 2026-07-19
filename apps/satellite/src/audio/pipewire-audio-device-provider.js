import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AudioDeviceProvider, normalizeDevice } from "./audio-device-provider.js";

const execFileAsync = promisify(execFile);

export class PipeWireAudioDeviceProvider extends AudioDeviceProvider {
  constructor({ exec = execFileAsync } = {}) {
    super("pipewire");
    this.exec = exec;
  }

  async list(kind) {
    const pactlKind = kind === "input" ? "sources" : "sinks";
    const { stdout } = await this.exec("pactl", ["-f", "json", "list", pactlKind], { timeout: 3000 });
    return JSON.parse(stdout)
      .filter((device) => kind !== "input" || !device.name?.endsWith(".monitor"))
      .map((device) => {
        const validText = (value) => typeof value === "string" && value.trim() && !/^(?:null|undefined|none|\(null\)|<null>)$/i.test(value.trim());
        const technicalId = validText(device.name) ? device.name.trim() : String(device.index ?? device.properties?.["object.id"] ?? "pipewire-unknown");
        const activePort = Array.isArray(device.ports)
          ? device.ports.find((port) => port.name === device.active_port || port.name === device.active_port?.name)
          : null;
        const description = [
          device.description,
          device.properties?.["device.description"],
          device.properties?.["node.description"],
          device.properties?.["node.nick"],
          device.properties?.["device.product.name"],
          device.properties?.["alsa.card_name"],
          device.properties?.["alsa.long_card_name"],
          activePort?.description,
          device.name
        ]
          .find(validText);
        return normalizeDevice(
          technicalId,
          description?.trim() || `${kind === "input" ? "Entrada" : "Salida"} PipeWire ${technicalId}`,
          // SUSPENDED significa inactivo y se reactiva al abrirlo; no está desconectado.
          { available: device.state !== "UNAVAILABLE", backend: this.name }
        );
      });
  }

  listInputDevices() {
    return this.list("input");
  }

  listOutputDevices() {
    return this.list("output");
  }

  async listInputChannels(deviceId) {
    const { stdout } = await this.exec("pactl", ["-f", "json", "list", "sources"], { timeout: 3000 });
    const device = JSON.parse(stdout).find((source) => source.name === deviceId || String(source.index) === String(deviceId));
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
