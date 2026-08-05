import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class WakeWordTrainingService {
  constructor({ store, executable = "", log = () => {}, spawnProcess = spawn, now = () => new Date() }) {
    this.store = store;
    this.executable = String(executable || "").trim();
    this.log = log;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.jobs = new Map();
    this.activeByModel = new Map();
    this.automaticTimer = null;
    this.automaticScanPending = false;
  }

  capabilities() {
    return { trainingAvailable: Boolean(this.executable), evaluationAvailable: Boolean(this.executable) };
  }

  startAutomatic(intervalMs = 10 * 60_000) {
    const milliseconds = Math.max(10_000, Number(intervalMs) || 10 * 60_000);
    if (this.automaticTimer) clearInterval(this.automaticTimer);
    void this.scanAutomatic();
    this.automaticTimer = setInterval(() => void this.scanAutomatic(), milliseconds);
    this.automaticTimer.unref?.();
    return this.automaticTimer;
  }

  stopAutomatic() {
    if (this.automaticTimer) clearInterval(this.automaticTimer);
    this.automaticTimer = null;
  }

  async scanAutomatic() {
    if (this.automaticScanPending || this.activeByModel.size) return [];
    this.automaticScanPending = true;
    try {
      const started = [];
      for (const model of await this.store.list()) {
        const latestSampleAt = await this.store.latestSampleModifiedAt(model.id);
        if (!latestSampleAt) continue;
        const modelModifiedAt = model.file?.modifiedAt || "1970-01-01T00:00:00.000Z";
        if (new Date(latestSampleAt) <= new Date(modelModifiedAt)) continue;
        const job = await this.start(model.id);
        started.push(job);
        this.log("info", "Nuevas muestras detectadas; autoentrenamiento iniciado", {
          modelId: model.id,
          latestSampleAt,
          modelModifiedAt
        });
        break;
      }
      return started;
    } catch (error) {
      this.log("warn", "No se pudo revisar el autoentrenamiento de wake words", { error: error.message });
      return [];
    } finally {
      this.automaticScanPending = false;
    }
  }

  async evaluate(modelId, audio, { threshold = 0.995 } = {}) {
    if (!this.executable) {
      const error = new Error("El evaluador de modelos no está configurado en el servidor");
      error.code = "TRAINER_UNAVAILABLE";
      throw error;
    }
    const model = await this.store.describe(modelId);
    if (!model.file) {
      const error = new Error("Entrena o carga primero un archivo ONNX");
      error.code = "MODEL_FILE_MISSING";
      throw error;
    }
    const audioPath = join(this.store.directory(model.id), `evaluation-${randomUUID()}.wav`);
    await writeFile(audioPath, audio);
    try {
      const output = await new Promise((resolve, reject) => {
        const child = this.spawnProcess(this.executable, [
          "--evaluate",
          "--model", this.store.modelPath(model.id),
          "--audio", audioPath,
          "--threshold", String(threshold)
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(stderr.trim() || `El evaluador terminó con código ${code ?? signal}`));
        });
      });
      return JSON.parse(output.trim());
    } finally {
      await rm(audioPath, { force: true }).catch(() => {});
    }
  }

  listJobs() {
    return [...this.jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  job(id) {
    const job = this.jobs.get(id);
    if (!job) {
      const error = new Error(`No existe el trabajo ${id}`);
      error.code = "JOB_NOT_FOUND";
      throw error;
    }
    return job;
  }

  async start(modelId, options = {}) {
    if (!this.executable) {
      const error = new Error("El ejecutable de entrenamiento no está configurado en el servidor");
      error.code = "TRAINER_UNAVAILABLE";
      throw error;
    }
    if (this.activeByModel.has(modelId)) {
      const error = new Error("Ya hay un entrenamiento en curso para este modelo");
      error.code = "TRAINING_ACTIVE";
      throw error;
    }
    const model = await this.store.describe(modelId);
    const job = {
      id: randomUUID(),
      modelId,
      status: "queued",
      createdAt: this.now().toISOString(),
      startedAt: null,
      completedAt: null,
      error: null,
      log: []
    };
    this.jobs.set(job.id, job);
    this.activeByModel.set(modelId, job.id);
    void this.run(job, model, options);
    return job;
  }

  async run(job, model, options) {
    const outputPath = join(this.store.directory(model.id), `trained-${job.id}.onnx`);
    Object.assign(job, { status: "running", startedAt: this.now().toISOString() });
    const args = [
      "--model-id", model.id,
      "--wake-word", model.wakeWord,
      "--model-dir", this.store.directory(model.id),
      "--output", outputPath,
      "--config-json", JSON.stringify(options || {})
    ];
    this.log("info", "Entrenamiento de wake word iniciado", { jobId: job.id, modelId: model.id });
    try {
      await new Promise((resolve, reject) => {
        const child = this.spawnProcess(this.executable, args, { stdio: ["ignore", "pipe", "pipe"] });
        const collect = (kind, chunk) => {
          const line = String(chunk).trim();
          if (!line) return;
          job.log.push({ at: this.now().toISOString(), kind, text: line.slice(0, 4000) });
          if (job.log.length > 200) job.log.shift();
        };
        child.stdout?.on("data", (chunk) => collect("stdout", chunk));
        child.stderr?.on("data", (chunk) => collect("stderr", chunk));
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`El entrenador terminó con código ${code ?? signal}`)));
      });
      await access(outputPath);
      await this.store.replaceModelFile(model.id, await readFile(outputPath), `${model.id}.onnx`);
      await rm(outputPath, { force: true });
      Object.assign(job, { status: "completed", completedAt: this.now().toISOString() });
      this.log("info", "Entrenamiento de wake word completado", { jobId: job.id, modelId: model.id });
    } catch (error) {
      Object.assign(job, { status: "failed", completedAt: this.now().toISOString(), error: error.message });
      await rm(outputPath, { force: true }).catch(() => {});
      this.log("warn", "Entrenamiento de wake word fallido", { jobId: job.id, modelId: model.id, error: error.message });
    } finally {
      this.activeByModel.delete(model.id);
    }
  }
}
