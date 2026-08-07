import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function splitForStreaming(text, maximumCharacters = 300) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?;:]+[.!?;:]?|.+$/g) || [normalized];
  const segments = [];
  let current = "";
  for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
    if (!current) current = sentence;
    else if (`${current} ${sentence}`.length <= maximumCharacters) current = `${current} ${sentence}`;
    else {
      segments.push(current);
      current = sentence;
    }
    while (current.length > maximumCharacters) {
      let splitAt = current.lastIndexOf(" ", maximumCharacters);
      if (splitAt < maximumCharacters / 2) splitAt = maximumCharacters;
      segments.push(current.slice(0, splitAt).trim());
      current = current.slice(splitAt).trim();
    }
  }
  if (current) segments.push(current);
  return segments;
}

const SAMPLE_RATE = 24_000;
const SPANISH_VOICES = Object.freeze([
  { id: "ef_dora", name: "Kokoro · Dora", gender: "female" },
  { id: "em_alex", name: "Kokoro · Alex", gender: "male" },
  { id: "em_santa", name: "Kokoro · Santa", gender: "male" },
  { id: "ef_dora,em_alex", name: "Kokoro · Dora + Alex", gender: "mixed" },
  { id: "ef_dora,em_santa", name: "Kokoro · Dora + Santa", gender: "mixed" },
  { id: "em_alex,em_santa", name: "Kokoro · Alex + Santa", gender: "male" }
]);

export class KokoroStreamingTts {
  constructor({
    pythonExecutable,
    device = "auto",
    workerPath = new URL("./kokoro_worker.py", import.meta.url).pathname,
    startupTimeoutMs = 600_000,
    requestTimeoutMs = 60_000,
    log = () => {}
  }) {
    this.name = "kokoro";
    this.sampleRate = SAMPLE_RATE;
    this.pythonExecutable = pythonExecutable;
    this.device = device;
    this.workerPath = workerPath;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.log = log;
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.errors = "";
  }

  async initialize() {
    if (this.ready) return this.ready;
    this.ready = this.#start();
    try {
      await this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  async #start() {
    const child = spawn(this.pythonExecutable, [this.workerPath, "--device", this.device], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: process.env.PYTORCH_ENABLE_MPS_FALLBACK || "1" }
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.errors = `${this.errors}${chunk}`.slice(-12_000);
      if (process.env.KOKORO_LOG_STDERR === "true") this.log("info", "Kokoro", { output: String(chunk).trim().slice(-1000) });
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.#handleLine(line));
    child.once("exit", (code, signal) => {
      const error = new Error(`Kokoro terminó${code === null ? "" : ` con código ${code}`}${signal ? ` (${signal})` : ""}: ${this.errors.trim()}`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.child = null;
      this.ready = null;
    });
    child.once("error", (error) => {
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
    const response = await this.#request({ type: "initialize" }, this.startupTimeoutMs);
    this.sampleRate = Number(response.sampleRate || SAMPLE_RATE);
    this.log("info", "Kokoro listo", { device: response.device, sampleRate: this.sampleRate });
  }

  #handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.type === "error") request.reject(new Error(message.message || "Falló Kokoro"));
    else request.resolve(message);
  }

  #request(payload, timeoutMs = this.requestTimeoutMs) {
    if (!this.child || this.child.exitCode !== null || !this.child.stdin.writable) {
      return Promise.reject(new Error("El proceso Kokoro no está disponible"));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Kokoro excedió ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }

  async listVoices() {
    await this.initialize();
    return SPANISH_VOICES.map((voice) => ({ ...voice, language: "es", provider: this.name, sampleRate: this.sampleRate }));
  }

  async *synthesize(text, { voiceId = SPANISH_VOICES[0].id, signal } = {}) {
    await this.initialize();
    if (!SPANISH_VOICES.some((voice) => voice.id === voiceId)) throw new Error(`Voz Kokoro desconocida: ${voiceId}`);
    for (const segment of splitForStreaming(text, 300)) {
      if (signal?.aborted) throw signal.reason || new Error("Síntesis cancelada");
      const response = await this.#request({ type: "synthesize", text: segment, voice: voiceId });
      if (signal?.aborted) throw signal.reason || new Error("Síntesis cancelada");
      yield Buffer.from(response.audio, "base64");
    }
  }

  close() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }
}
