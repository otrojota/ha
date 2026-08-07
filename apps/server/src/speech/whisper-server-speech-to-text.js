import { spawn } from "node:child_process";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class WhisperServerSpeechToText {
  constructor({
    executable = "whisper-server",
    modelPath,
    language = "es",
    noGpu = false,
    threads = 4,
    bestOf = 2,
    host = "127.0.0.1",
    port = 8178,
    startupTimeoutMs = 120_000,
    requestTimeoutMs = 120_000,
    managed = true,
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    log = () => {}
  } = {}) {
    this.executable = executable;
    this.modelPath = modelPath;
    this.language = language;
    this.noGpu = noGpu;
    this.threads = Math.max(1, Math.trunc(Number(threads) || 4));
    this.bestOf = Math.max(1, Math.trunc(Number(bestOf) || 2));
    this.host = host;
    this.port = Number(port);
    this.startupTimeoutMs = Number(startupTimeoutMs);
    this.requestTimeoutMs = Number(requestTimeoutMs);
    this.managed = managed === true;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.log = log;
    this.child = null;
    this.baseUrl = `http://${this.host}:${this.port}`;
  }

  async initialize() {
    if (!this.modelPath) throw new Error("Falta configurar el modelo de Whisper");
    if (await this.#isReady()) return;
    if (!this.managed) throw new Error(`whisper-server no responde en ${this.baseUrl}`);
    const args = [
      "-m", this.modelPath,
      "-l", this.language,
      "-t", String(this.threads),
      "-bo", String(this.bestOf),
      "--host", this.host,
      "--port", String(this.port),
      "-nt", "-sns"
    ];
    if (this.noGpu) args.unshift("-ng");
    const child = this.spawn(this.executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    let errors = "";
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => {
      errors = `${errors}${chunk}`.slice(-8_000);
    });
    const exited = new Promise((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(
        `whisper-server terminó antes de iniciar${code === null ? "" : ` (${code})`}${signal ? ` [${signal}]` : ""}: ${errors.trim()}`
      )));
    });
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await Promise.race([this.#isReady(), exited])) {
        this.log("info", "whisper-server disponible", {
          url: this.baseUrl,
          modelPath: this.modelPath,
          language: this.language,
          gpuEnabled: !this.noGpu,
          threads: this.threads,
          bestOf: this.bestOf
        });
        return;
      }
      await Promise.race([wait(250), exited]);
    }
    this.close();
    throw new Error(`whisper-server no estuvo disponible después de ${this.startupTimeoutMs} ms`);
  }

  async transcribe(audio) {
    const wav = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
    if (!wav.length) return "";
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    form.append("language", this.language);
    form.append("response_format", "json");
    form.append("temperature", "0.0");
    form.append("no_speech_thold", "0.6");
    form.append("suppress_nst", "true");
    const response = await this.fetch(`${this.baseUrl}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (!response.ok) throw new Error(`whisper-server respondió HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) return (await response.text()).trim();
    const payload = await response.json();
    if (payload?.error) throw new Error(String(payload.error));
    return String(payload?.text || "").trim();
  }

  close() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }

  async #isReady() {
    try {
      const response = await this.fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(500) });
      return response.ok;
    } catch {
      return false;
    }
  }
}
