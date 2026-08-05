import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pcmToWav } from "./voice-capture.js";

const PCM_BYTES_PER_SECOND = 16_000 * 2;

export class OpenWakeWordDetector {
  constructor({
    python, scriptPath, modelPath, melspectrogramPath, embeddingPath,
    wakeWord, threshold = 0.8, patience = 2, cooldownMs = 2000,
    minimumAudioDb = -55, audioActivityWindowMs = 1000,
    activationAudioSeconds = 3, onDetected, log, spawnProcess = spawn
  }) {
    Object.assign(this, {
      python, scriptPath, modelPath, melspectrogramPath, embeddingPath,
      wakeWord, threshold, patience, cooldownMs, minimumAudioDb, audioActivityWindowMs,
      activationAudioSeconds, onDetected, log, spawnProcess
    });
    this.process = null;
    this.recentAudio = Buffer.alloc(0);
    this.resetWaiters = [];
  }

  async start() {
    if (this.process) return;
    const child = this.spawnProcess(this.python, [
      this.scriptPath,
      "--model", this.modelPath,
      "--melspectrogram", this.melspectrogramPath,
      "--embedding", this.embeddingPath,
      "--wake-word", this.wakeWord,
      "--threshold", String(this.threshold),
      "--patience", String(this.patience),
      "--cooldown-ms", String(this.cooldownMs),
      "--minimum-audio-db", String(this.minimumAudioDb),
      "--audio-activity-window-ms", String(this.audioActivityWindowMs)
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => this.log("warn", "openWakeWord", { detail: data.trim() }));
    child.once("close", (code) => {
      if (this.process === child) this.process = null;
      if (code && code !== 0) this.log("warn", "Detector openWakeWord finalizado", { code });
    });
    const lines = createInterface({ input: child.stdout });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("openWakeWord no quedó listo dentro del tiempo esperado")), 30_000);
      child.once("error", reject);
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line);
          if (message.type === "ready") {
            clearTimeout(timeout);
            resolve();
          } else if (message.type === "detected") {
            const audio = pcmToWav(this.recentAudio);
            this.recentAudio = Buffer.alloc(0);
            this.onDetected({ ...message, audio });
          } else if (message.type === "reset") {
            for (const resolveReset of this.resetWaiters.splice(0)) resolveReset();
          }
        } catch (error) {
          this.log("warn", "Respuesta openWakeWord inválida", { line, error: error.message });
        }
      });
    });
  }

  write(audio) {
    if (!Buffer.isBuffer(audio) || !audio.length) return;
    const maximumBytes = Math.max(1, Math.round(this.activationAudioSeconds * PCM_BYTES_PER_SECOND));
    this.recentAudio = Buffer.concat([this.recentAudio, audio]).subarray(-maximumBytes);
    if (this.process?.stdin.writable) this.process.stdin.write(audio);
  }

  async reset() {
    this.recentAudio = Buffer.alloc(0);
    const child = this.process;
    if (!child) return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        const index = this.resetWaiters.indexOf(finish);
        if (index >= 0) this.resetWaiters.splice(index, 1);
        resolve();
      };
      const timeout = setTimeout(finish, 500);
      this.resetWaiters.push(finish);
      if (!child.kill("SIGUSR1")) {
        finish();
      }
    });
  }

  stop() {
    this.process?.stdin.end();
    this.process?.kill("SIGTERM");
    this.process = null;
    this.recentAudio = Buffer.alloc(0);
    for (const resolveReset of this.resetWaiters.splice(0)) resolveReset();
  }
}
