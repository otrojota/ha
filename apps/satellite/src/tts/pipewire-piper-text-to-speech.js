import { spawn } from "node:child_process";
import { readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { TextToSpeechProvider } from "./text-to-speech-provider.js";

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} terminó con código ${code}: ${stderr.trim()}`)));
    if (input) child.stdin.end(input);
  });
}

export class PipeWirePiperTextToSpeech extends TextToSpeechProvider {
  constructor({ modelsPath = "dev/satellite/models/piper", executable = "piper" } = {}) {
    super("piper");
    this.modelsPath = modelsPath;
    this.executable = executable;
    this.models = new Map();
  }

  async listVoices() {
    const entries = await readdir(this.modelsPath, { recursive: true, withFileTypes: true }).catch(() => []);
    const voices = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".onnx")).map((entry) => {
      const path = join(entry.parentPath || entry.path || this.modelsPath, entry.name);
      const id = basename(entry.name, ".onnx");
      this.models.set(id, path);
      return { id, name: id.replaceAll("_", " "), language: id.split("-")[0] };
    });
    return voices.sort((a, b) => a.name.localeCompare(b.name));
  }

  async speak(text, { outputDeviceId, voiceId }) {
    if (!voiceId) throw new Error("No hay una voz Piper configurada");
    if (!this.models.has(voiceId)) await this.listVoices();
    const model = this.models.get(voiceId);
    if (!model) throw new Error(`No se encontró el modelo Piper ${voiceId}`);
    const outputPath = join(tmpdir(), `ha-tts-${randomUUID()}.wav`);
    try {
      await run(this.executable, ["--model", model, "--output_file", outputPath], `${text}\n`);
      await run("pw-play", [...(outputDeviceId ? ["--target", outputDeviceId] : []), outputPath]);
    } finally {
      await unlink(outputPath).catch(() => {});
    }
  }
}
