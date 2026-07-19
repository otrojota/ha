import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { TextToSpeechProvider } from "./text-to-speech-provider.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const regions = { es_AR: "Argentina", es_ES: "España", es_MX: "México" };
const qualities = { x_low: "muy liviana", low: "liviana", medium: "media", high: "alta" };

function voiceLabel(id) {
  const [locale = "es", rest = id] = id.split("-");
  const parts = rest.split("-");
  const quality = parts.pop();
  const speaker = parts.join("-").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return `${speaker} · Español (${regions[locale] || locale}) · Calidad ${qualities[quality] || quality}`;
}

export class PipeWirePiperTextToSpeech extends TextToSpeechProvider {
  constructor({ modelsPath = "dev/satellite/models/piper", executable = "piper", pythonExecutable = "python3", workerPath = new URL("./piper_worker.py", import.meta.url).pathname } = {}) {
    super("piper");
    this.modelsPath = modelsPath;
    this.executable = executable;
    this.pythonExecutable = pythonExecutable;
    this.workerPath = workerPath;
    this.models = new Map();
    this.session = null;
    this.sessionPromise = null;
    this.startingWorker = null;
    this.pending = new Map();
  }

  async listVoices() {
    const entries = await readdir(this.modelsPath, { recursive: true, withFileTypes: true }).catch(() => []);
    const voices = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".onnx")).map((entry) => {
      const path = join(entry.parentPath || entry.path || this.modelsPath, entry.name);
      const id = basename(entry.name, ".onnx");
      this.models.set(id, path);
      return { id, name: voiceLabel(id), language: `Español (${regions[id.split("-")[0]] || id.split("-")[0]})` };
    });
    return voices.sort((a, b) => a.name.localeCompare(b.name));
  }

  async modelFor(voiceId) {
    if (!this.models.has(voiceId)) await this.listVoices();
    const model = this.models.get(voiceId);
    if (!model) throw new Error(`No se encontró el modelo Piper ${voiceId}`);
    return model;
  }

  async prepare(voiceId, outputDeviceId = null) {
    if (!voiceId) throw new Error("No hay una voz Piper configurada");
    const model = await this.modelFor(voiceId);
    if (this.session?.voiceId === voiceId && this.session.outputDeviceId === outputDeviceId) return this.session;
    if (this.sessionPromise?.voiceId === voiceId && this.sessionPromise.outputDeviceId === outputDeviceId) return this.sessionPromise.promise;

    this.stop();
    const promise = this.startSession({ voiceId, model, outputDeviceId });
    this.sessionPromise = { voiceId, outputDeviceId, promise };
    try { return await promise; }
    finally { if (this.sessionPromise?.promise === promise) this.sessionPromise = null; }
  }

  startSession({ voiceId, model, outputDeviceId }) {
    return new Promise((resolve, reject) => {
      const worker = spawn(this.pythonExecutable, [this.workerPath, model], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
      let player = null;
      this.startingWorker = worker;
      let workerErrors = "";
      let buffer = "";
      let settled = false;
      const fail = (error) => {
        const ownsSession = this.session?.worker === worker || this.startingWorker === worker;
        if (!ownsSession) {
          if (!settled) { settled = true; reject(error); }
          return;
        }
        if (!settled) { settled = true; reject(error); }
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        worker.stdio[3]?.unpipe(player?.stdin);
        if (player && player.exitCode === null && player.signalCode === null) player.kill("SIGTERM");
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
        if (this.session?.worker === worker) this.session = null;
        if (this.startingWorker === worker) this.startingWorker = null;
      };
      worker.stderr.setEncoding("utf8");
      worker.stderr.on("data", (chunk) => { workerErrors = `${workerErrors}${chunk}`.slice(-4000); });
      worker.once("error", fail);
      worker.once("exit", (code, signal) => fail(new Error(`Worker Piper terminó${code === null ? "" : ` con código ${code}`}${signal ? ` (${signal})` : ""}: ${workerErrors.trim()}`)));
      worker.stdout.setEncoding("utf8");
      worker.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.type === "ready") {
            const playerArgs = ["--playback", "--raw", "--rate", String(message.sampleRate), "--channels", "1", "--format", "s16", "--latency", "100ms"];
            if (outputDeviceId) playerArgs.push("--target", outputDeviceId);
            playerArgs.push("-");
            player = spawn("pw-cat", playerArgs, { stdio: ["pipe", "ignore", "pipe"] });
            let playerErrors = "";
            player.stderr.setEncoding("utf8");
            player.stderr.on("data", (data) => { playerErrors = `${playerErrors}${data}`.slice(-4000); });
            player.once("error", fail);
            player.once("exit", (code, signal) => {
              if (this.session?.player === player) fail(new Error(`pw-cat terminó${code === null ? "" : ` con código ${code}`}${signal ? ` (${signal})` : ""}: ${playerErrors.trim()}`));
            });
            worker.stdio[3].pipe(player.stdin);
            this.session = { voiceId, outputDeviceId, worker, player, sampleRate: message.sampleRate };
            if (this.startingWorker === worker) this.startingWorker = null;
            settled = true;
            resolve(this.session);
          } else {
            this.handleWorkerMessage(message);
          }
        }
      });
    });
  }

  handleWorkerMessage(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "audio") pending.audioStartedAt = performance.now();
    if (message.type === "error") {
      this.pending.delete(message.id);
      pending.reject(new Error(message.message || "Falló Piper"));
    }
    if (message.type === "done") {
      this.pending.delete(message.id);
      const elapsedPlayback = pending.audioStartedAt ? (performance.now() - pending.audioStartedAt) / 1000 : 0;
      const remainingMs = Math.max(100, (Number(message.audioSeconds || 0) - elapsedPlayback) * 1000 + 150);
      delay(remainingMs).then(() => pending.resolve(message));
    }
  }

  async speak(text, { outputDeviceId, voiceId }) {
    const session = await this.prepare(voiceId, outputDeviceId || null);
    const id = randomUUID();
    const completion = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, audioStartedAt: null }));
    session.worker.stdin.write(`${JSON.stringify({ id, text })}\n`);
    await completion;
  }

  stop() {
    const error = new Error("Sesión Piper reemplazada");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.session) {
      this.session.worker.stdio[3].unpipe(this.session.player.stdin);
      this.session.worker.kill("SIGTERM");
      this.session.player.kill("SIGTERM");
      this.session = null;
    }
    if (this.startingWorker) {
      this.startingWorker.kill("SIGTERM");
      this.startingWorker = null;
    }
  }
}
