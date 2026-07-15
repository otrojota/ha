import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TextToSpeechProvider } from "./text-to-speech-provider.js";

const execFileAsync = promisify(execFile);

export class CoreAudioTextToSpeech extends TextToSpeechProvider {
  constructor() {
    super("macos-say");
  }

  async listVoices() {
    const { stdout } = await execFileAsync("say", ["-v", "?"], { timeout: 5000, killSignal: "SIGKILL" });
    const voices = stdout.split("\n").flatMap((line) => {
      const match = line.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/);
      if (!match || !match[2].startsWith("es_")) return [];
      return [{ id: match[1].trim(), name: `${match[1].trim()} · ${match[2]}`, language: match[2] }];
    });
    const preferred = new Map([["Mónica", 0], ["Paulina", 1]]);
    return voices.sort((a, b) => (preferred.get(a.id) ?? 10) - (preferred.get(b.id) ?? 10) || a.name.localeCompare(b.name));
  }

  async speak(text, { outputDeviceId, voiceId }) {
    const output = /^coreaudio:(\d+)$/.exec(outputDeviceId || "");
    if (outputDeviceId && !output) throw new Error("La salida CoreAudio configurada no es válida");
    const args = output ? ["-a", output[1]] : [];
    if (voiceId) args.push("-v", voiceId);
    args.push(text);
    await execFileAsync("say", args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
  }
}
