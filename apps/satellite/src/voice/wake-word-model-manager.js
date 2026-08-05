import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FEATURE_MODELS = {
  "melspectrogram.onnx": {
    url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx",
    sha256: "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f"
  },
  "embedding_model.onnx": {
    url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx",
    sha256: "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f"
  }
};

function validModelId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("Identificador de modelo inválido");
  return id;
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export class WakeWordModelManager {
  constructor({ rootPath, serverProvider, fetchImpl = fetch, log = () => {} }) {
    this.rootPath = rootPath;
    this.serverProvider = serverProvider;
    this.fetch = fetchImpl;
    this.log = log;
  }

  directory(id) { return join(this.rootPath, validModelId(id)); }
  modelPath(id) { return join(this.directory(id), "model.onnx"); }
  metadataPath(id) { return join(this.directory(id), "model.json"); }
  featurePath(name) { return join(this.rootPath, "features", name); }

  serverUrl() {
    const url = this.serverProvider()?.httpUrl;
    if (!url) throw new Error("El servidor todavía no está disponible");
    return url;
  }

  async localMetadata(id) {
    return readJson(this.metadataPath(id));
  }

  async catalog() {
    const response = await this.fetch(`${this.serverUrl()}/api/wake-word/models`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`El servidor respondió HTTP ${response.status}`);
    const result = await response.json();
    return Promise.all((result.models || []).filter((model) => model.file).map(async (model) => {
      const local = await this.localMetadata(model.id);
      const downloaded = Boolean(
        local?.file?.sha256
        && local.file.sha256 === model.file.sha256
        && local.file.modifiedAt === model.file.modifiedAt
      );
      return {
        ...model,
        local: local ? {
          downloaded,
          modifiedAt: local.file?.modifiedAt || null,
          sha256: local.file?.sha256 || null
        } : null,
        updateAvailable: Boolean(local && !downloaded)
      };
    }));
  }

  async addSample(id, kind, audio, originalName = `${kind}.wav`) {
    const normalizedId = validModelId(id);
    if (!["positive", "negative"].includes(kind)) throw new Error("El tipo de muestra debe ser positive o negative");
    if (!Buffer.isBuffer(audio) || audio.length <= 44) throw new Error("No hay audio de la detección para reportar");
    const response = await this.fetch(`${this.serverUrl()}/api/wake-word/models/${normalizedId}/samples/${kind}`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-File-Name": originalName
      },
      body: audio,
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`El servidor rechazó la muestra ${kind === "positive" ? "positiva" : "negativa"} (HTTP ${response.status})`);
    return response.json();
  }

  async addNegativeSample(id, audio, originalName = "false-detection.wav") {
    return this.addSample(id, "negative", audio, originalName);
  }

  async addPositiveSample(id, audio, originalName = "accepted-detection.wav") {
    return this.addSample(id, "positive", audio, originalName);
  }

  async train(id) {
    const normalizedId = validModelId(id);
    const response = await this.fetch(`${this.serverUrl()}/api/wake-word/models/${normalizedId}/train`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `El servidor rechazó el entrenamiento (HTTP ${response.status})`);
    return result;
  }

  async remoteModel(id) {
    const models = await this.catalog();
    const model = models.find((item) => item.id === validModelId(id));
    if (!model) throw new Error(`El servidor no ofrece el modelo ${id}`);
    return model;
  }

  async ensureFeatures() {
    await mkdir(join(this.rootPath, "features"), { recursive: true });
    for (const [name, resource] of Object.entries(FEATURE_MODELS)) {
      const path = this.featurePath(name);
      const current = await readFile(path).catch(() => null);
      if (current && digest(current) === resource.sha256) continue;
      this.log("info", "Descargando extractor openWakeWord", { name });
      const response = await this.fetch(resource.url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`No se pudo descargar ${name}: HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (digest(buffer) !== resource.sha256) throw new Error(`La verificación SHA-256 de ${name} falló`);
      const temporary = `${path}.tmp`;
      await writeFile(temporary, buffer);
      await rename(temporary, path);
    }
  }

  async hasUsableLocalModel(id) {
    const metadata = await this.localMetadata(id);
    if (!metadata?.file?.sha256) return false;
    try {
      return digest(await readFile(this.modelPath(id))) === metadata.file.sha256;
    } catch {
      return false;
    }
  }

  async download(id, remote = null) {
    const model = remote || await this.remoteModel(id);
    await mkdir(this.directory(model.id), { recursive: true });
    const response = await this.fetch(`${this.serverUrl()}/api/wake-word/models/${model.id}/download`, {
      signal: AbortSignal.timeout(60_000),
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`No se pudo descargar ${model.name}: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const hash = digest(buffer);
    if (hash !== model.file.sha256) throw new Error(`El SHA-256 descargado de ${model.name} no coincide`);
    const temporary = `${this.modelPath(model.id)}.tmp`;
    await writeFile(temporary, buffer);
    await rename(temporary, this.modelPath(model.id));
    await writeFile(this.metadataPath(model.id), `${JSON.stringify({
      id: model.id,
      name: model.name,
      wakeWord: model.wakeWord,
      file: { ...model.file, sha256: hash },
      downloadedAt: new Date().toISOString()
    }, null, 2)}\n`);
    await this.ensureFeatures();
    this.log("info", "Modelo wake word descargado", { id: model.id, sha256: hash });
    return this.localMetadata(model.id);
  }

  async ensureCurrent(id, { allowCached = true } = {}) {
    const normalizedId = validModelId(id);
    try {
      const remote = await this.remoteModel(normalizedId);
      const local = await this.localMetadata(normalizedId);
      if (local?.file?.sha256 !== remote.file.sha256
        || local?.file?.modifiedAt !== remote.file.modifiedAt
        || !await this.hasUsableLocalModel(normalizedId)) {
        await this.download(normalizedId, remote);
      } else {
        await this.ensureFeatures();
      }
      return this.runtimeFiles(normalizedId);
    } catch (error) {
      if (!allowCached || !await this.hasUsableLocalModel(normalizedId)) throw error;
      await this.ensureFeatures();
      this.log("warn", "Se usará el modelo wake word almacenado localmente", { id: normalizedId, error: error.message });
      return this.runtimeFiles(normalizedId);
    }
  }

  async runtimeFiles(id) {
    const normalizedId = validModelId(id);
    await Promise.all([
      access(this.modelPath(normalizedId)),
      access(this.featurePath("melspectrogram.onnx")),
      access(this.featurePath("embedding_model.onnx"))
    ]);
    return {
      modelPath: this.modelPath(normalizedId),
      melspectrogramPath: this.featurePath("melspectrogram.onnx"),
      embeddingPath: this.featurePath("embedding_model.onnx"),
      metadata: await this.localMetadata(normalizedId)
    };
  }
}
