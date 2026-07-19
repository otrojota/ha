import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 10)));
}

function pipeWireVolume(device) {
  const channels = Object.values(device?.volume || {}).map((channel) => {
    const percent = String(channel?.value_percent || "").match(/([0-9]+(?:\.[0-9]+)?)%/);
    if (percent) return Number(percent[1]);
    const value = Number(channel?.value);
    if (!Number.isFinite(value)) return null;
    // pactl usa 65536 como volumen nominal (100%). Algunos dobles de prueba y
    // backends alternativos exponen en cambio una fracción entre 0 y 1.
    return value <= 1 ? value * 100 : value * 100 / 65536;
  });
  const valid = channels.filter(Number.isFinite);
  return valid.length ? Math.round(Math.max(...valid)) : null;
}

export class OutputVolumeDucker {
  constructor({ platform = process.platform, readConfig, duckPercent = 10, exec = execFileAsync, log = () => {} }) {
    this.platform = platform;
    this.readConfig = readConfig;
    this.duckPercent = clampPercent(duckPercent);
    this.exec = exec;
    this.log = log;
    this.saved = null;
    this.operation = Promise.resolve();
  }

  duck() {
    return this.enqueue(async () => {
      if (this.saved) return;
      const config = await this.readConfig();
      if (this.platform === "linux") await this.duckPipeWire(config.musicOutputDeviceId || config.outputDeviceId);
      else if (this.platform === "darwin") await this.duckMacOs();
    });
  }

  restore() {
    return this.enqueue(async () => {
      const saved = this.saved;
      if (!saved) return;
      if (saved.platform === "linux") {
        await this.exec("pactl", ["set-sink-volume", saved.deviceId, `${saved.volumePercent}%`], { timeout: 3000 });
      } else if (saved.platform === "darwin") {
        await this.exec("osascript", ["-e", `set volume output volume ${saved.volumePercent}`], { timeout: 3000 });
      }
      // Sólo se descarta después de que el sistema confirma la restauración.
      // Así una ruta posterior (timeout, error o cierre) puede reintentarla.
      if (this.saved === saved) this.saved = null;
      this.log("info", "Volumen local restaurado después de escuchar", { volumePercent: saved.volumePercent });
    });
  }

  enqueue(action) {
    const result = this.operation.then(action);
    this.operation = result.catch((error) => this.log("warn", "No se pudo ajustar el volumen local durante la escucha", { error: error.message }));
    return result;
  }

  async duckPipeWire(outputDeviceId) {
    const { stdout } = await this.exec("pactl", ["-f", "json", "list", "sinks"], { timeout: 3000 });
    const sinks = JSON.parse(stdout);
    const sink = sinks.find((item) => item.name === outputDeviceId || String(item.index) === String(outputDeviceId))
      || sinks.find((item) => item.state === "RUNNING")
      || sinks.find((item) => item.state !== "UNAVAILABLE");
    const volumePercent = pipeWireVolume(sink);
    if (!sink?.name || volumePercent === null) return;
    this.saved = { platform: "linux", deviceId: sink.name, volumePercent };
    const targetPercent = Math.min(volumePercent, this.duckPercent);
    await this.exec("pactl", ["set-sink-volume", sink.name, `${targetPercent}%`], { timeout: 3000 });
    this.log("info", "Volumen local reducido durante la escucha", { deviceId: sink.name, fromPercent: volumePercent, toPercent: targetPercent });
  }

  async duckMacOs() {
    const { stdout } = await this.exec("osascript", ["-e", "output volume of (get volume settings)"], { timeout: 3000 });
    const volumePercent = Number(String(stdout).trim());
    if (!Number.isFinite(volumePercent)) return;
    this.saved = { platform: "darwin", volumePercent: Math.round(volumePercent) };
    const targetPercent = Math.min(volumePercent, this.duckPercent);
    await this.exec("osascript", ["-e", `set volume output volume ${targetPercent}`], { timeout: 3000 });
    this.log("info", "Volumen local reducido durante la escucha", { fromPercent: volumePercent, toPercent: targetPercent });
  }
}
