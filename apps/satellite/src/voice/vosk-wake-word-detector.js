import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class VoskWakeWordDetector {
  constructor({ python, scriptPath, modelPath, wakeWord, cooldownMs = 5000, exactMinConfidence = 0.72, embeddedMinConfidence = 0.90, onDetected, log }) {
    this.python = python;
    this.scriptPath = scriptPath;
    this.modelPath = modelPath;
    this.wakeWord = wakeWord;
    this.cooldownMs = cooldownMs;
    this.exactMinConfidence = exactMinConfidence;
    this.embeddedMinConfidence = embeddedMinConfidence;
    this.onDetected = onDetected;
    this.log = log;
    this.process = null;
  }

  async start() {
    if (this.process) return;
    const child = spawn(this.python, [
      this.scriptPath,
      "--model", this.modelPath,
      "--wake-word", this.wakeWord,
      "--cooldown-ms", String(this.cooldownMs),
      "--exact-min-confidence", String(this.exactMinConfidence),
      "--embedded-min-confidence", String(this.embeddedMinConfidence)
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => this.log("warn", "Vosk", { detail: data.trim() }));
    child.once("close", (code) => {
      if (this.process === child) this.process = null;
      if (code && code !== 0) this.log("warn", "Detector Vosk finalizado", { code });
    });

    const lines = createInterface({ input: child.stdout });
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Vosk no quedó listo dentro del tiempo esperado")), 30_000);
      child.once("error", reject);
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line);
          if (message.type === "ready") {
            clearTimeout(timeout);
            resolve();
          } else if (message.type === "detected") {
            this.onDetected(message);
          }
        } catch (error) {
          this.log("warn", "Respuesta Vosk inválida", { line, error: error.message });
        }
      });
    });
    await ready;
  }

  write(audio) {
    if (this.process?.stdin.writable) this.process.stdin.write(audio);
  }

  stop() {
    this.process?.stdin.end();
    this.process?.kill("SIGTERM");
    this.process = null;
  }
}
