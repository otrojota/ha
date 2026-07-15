import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AudioDeviceProvider, normalizeDevice } from "./audio-device-provider.js";

const execFileAsync = promisify(execFile);

export class CoreAudioDeviceProvider extends AudioDeviceProvider {
  constructor() {
    super("coreaudio");
  }

  async listInputDevices() {
    let output = "";
    try {
      const result = await execFileAsync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], { timeout: 5000 });
      output = `${result.stdout || ""}\n${result.stderr || ""}`;
    } catch (error) {
      output = `${error.stdout || ""}\n${error.stderr || ""}`;
      if (!output.includes("AVFoundation audio devices:")) throw error;
    }

    const devices = [];
    let readingAudio = false;
    for (const line of output.split("\n")) {
      if (line.includes("AVFoundation audio devices:")) {
        readingAudio = true;
        continue;
      }
      if (!readingAudio) continue;
      const match = line.match(/\]\s+\[(\d+)\]\s+(.+)$/);
      if (match) devices.push(normalizeDevice(`avfoundation:${match[1]}`, match[2].trim(), { backend: this.name }));
    }
    return devices;
  }

  async listOutputDevices() {
    // `say` utiliza CoreAudio y sus IDs se pueden reutilizar directamente para reproducir TTS con `say -a <id>`.
    const { stdout } = await execFileAsync("say", ["-a", "?"], { timeout: 5000 });
    return stdout.split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
      return match ? [normalizeDevice(`coreaudio:${match[1]}`, match[2], { backend: this.name })] : [];
    });
  }

  async listInputChannels(deviceId) {
    const match = /^avfoundation:(\d+)$/.exec(deviceId);
    if (!match) throw new Error("Identificador AVFoundation inválido");
    let output = "";
    try {
      const result = await execFileAsync("ffmpeg", [
        "-hide_banner", "-f", "avfoundation", "-i", `:${match[1]}`,
        "-t", "0.05", "-f", "null", "-"
      ], { timeout: 5000 });
      output = `${result.stdout || ""}\n${result.stderr || ""}`;
    } catch (error) {
      output = `${error.stdout || ""}\n${error.stderr || ""}`;
      if (!output.includes("Audio:")) throw error;
    }
    const description = output.match(/Audio:[^\n]*?\d+\s+Hz,\s*([^,]+)/)?.[1]?.trim();
    const layouts = { mono: 1, stereo: 2, "2.1": 3, "3.0": 3, "4.0": 4, "5.0": 5, "5.1": 6, "7.1": 8 };
    const count = layouts[description] || Number(description?.match(/^(\d+)\s+channels?$/)?.[1]);
    if (!Number.isInteger(count) || count < 1) throw new Error("AVFoundation no informó la cantidad de canales");
    return Array.from({ length: count }, (_, id) => ({ id, name: `Canal ${id + 1}` }));
  }
}
