import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const MODEL_FILE_NAME = "model.onnx";
const METADATA_FILE_NAME = "model.json";
const SAMPLE_KINDS = new Set(["positive", "negative"]);

function cleanText(value, label, maximum = 80) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${label} es obligatorio`);
  if (result.length > maximum) throw new Error(`${label} supera ${maximum} caracteres`);
  return result;
}

function modelId(value) {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(result)) {
    throw new Error("El identificador debe usar sólo minúsculas, números y guiones");
  }
  return result;
}

function safeFileName(value, fallback) {
  const result = basename(String(value || fallback)).replace(/[^a-zA-Z0-9._-]/g, "_");
  return result || fallback;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

async function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function nextTimestamp(now, previous) {
  const current = now.getTime();
  const prior = previous ? new Date(previous).getTime() : 0;
  return new Date(Math.max(current, Number.isFinite(prior) ? prior + 1 : current)).toISOString();
}

export class WakeWordModelStore {
  constructor({ rootPath, now = () => new Date() }) {
    this.rootPath = rootPath;
    this.now = now;
  }

  async initialize() {
    await mkdir(this.rootPath, { recursive: true });
  }

  directory(id) {
    return join(this.rootPath, modelId(id));
  }

  metadataPath(id) {
    return join(this.directory(id), METADATA_FILE_NAME);
  }

  modelPath(id) {
    return join(this.directory(id), MODEL_FILE_NAME);
  }

  async readMetadata(id) {
    try {
      return JSON.parse(await readFile(this.metadataPath(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        const missing = new Error(`No existe el modelo ${id}`);
        missing.code = "MODEL_NOT_FOUND";
        throw missing;
      }
      throw error;
    }
  }

  async writeMetadata(metadata) {
    await atomicWrite(this.metadataPath(metadata.id), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  async create({ id, name, wakeWord, description = "" }) {
    const normalizedId = modelId(id);
    try {
      await this.readMetadata(normalizedId);
      const conflict = new Error(`Ya existe el modelo ${normalizedId}`);
      conflict.code = "MODEL_EXISTS";
      throw conflict;
    } catch (error) {
      if (error.code !== "MODEL_NOT_FOUND") throw error;
    }
    const timestamp = this.now().toISOString();
    const metadata = {
      id: normalizedId,
      name: cleanText(name, "El nombre"),
      wakeWord: cleanText(wakeWord, "La wake word"),
      description: String(description || "").trim().slice(0, 500),
      createdAt: timestamp,
      updatedAt: timestamp,
      file: null
    };
    await mkdir(this.directory(normalizedId), { recursive: true });
    await this.writeMetadata(metadata);
    return this.describe(normalizedId);
  }

  async list() {
    await this.initialize();
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    const models = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name)) continue;
      try { models.push(await this.describe(entry.name)); } catch (error) {
        if (error.code !== "MODEL_NOT_FOUND") throw error;
      }
    }
    return models.sort((left, right) => left.name.localeCompare(right.name, "es"));
  }

  async describe(id) {
    const metadata = await this.readMetadata(id);
    const samples = {};
    for (const kind of SAMPLE_KINDS) {
      try {
        samples[kind] = (await readdir(join(this.directory(id), "samples", kind))).length;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        samples[kind] = 0;
      }
    }
    return { ...metadata, samples };
  }

  async latestSampleModifiedAt(id) {
    await this.readMetadata(id);
    let latest = 0;
    for (const kind of SAMPLE_KINDS) {
      const directory = join(this.directory(id), "samples", kind);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fileStat = await stat(join(directory, entry.name));
        latest = Math.max(latest, fileStat.mtimeMs);
      }
    }
    return latest ? new Date(latest).toISOString() : null;
  }

  async update(id, { name, wakeWord, description }) {
    const metadata = await this.readMetadata(id);
    const updated = {
      ...metadata,
      ...(name !== undefined ? { name: cleanText(name, "El nombre") } : {}),
      ...(wakeWord !== undefined ? { wakeWord: cleanText(wakeWord, "La wake word") } : {}),
      ...(description !== undefined ? { description: String(description || "").trim().slice(0, 500) } : {}),
      updatedAt: this.now().toISOString()
    };
    await this.writeMetadata(updated);
    return this.describe(id);
  }

  async replaceModelFile(id, buffer, originalName = MODEL_FILE_NAME) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("El archivo del modelo está vacío");
    if (buffer.length > 50 * 1024 * 1024) throw new Error("El modelo supera el máximo de 50 MB");
    const metadata = await this.readMetadata(id);
    const path = this.modelPath(id);
    const modifiedAt = nextTimestamp(this.now(), metadata.file?.modifiedAt);
    await atomicWrite(path, buffer);
    await utimes(path, new Date(modifiedAt), new Date(modifiedAt));
    const fileStat = await stat(path);
    const updated = {
      ...metadata,
      updatedAt: modifiedAt,
      file: {
        name: safeFileName(originalName, MODEL_FILE_NAME),
        size: fileStat.size,
        modifiedAt,
        sha256: await sha256(buffer)
      }
    };
    await this.writeMetadata(updated);
    return this.describe(id);
  }

  async readModelFile(id) {
    const metadata = await this.readMetadata(id);
    if (!metadata.file) {
      const error = new Error(`El modelo ${id} todavía no tiene un archivo entrenado`);
      error.code = "MODEL_FILE_MISSING";
      throw error;
    }
    return { metadata, buffer: await readFile(this.modelPath(id)) };
  }

  async addSample(id, kind, buffer, originalName = "sample.wav") {
    await this.readMetadata(id);
    if (!SAMPLE_KINDS.has(kind)) throw new Error("El tipo de muestra debe ser positive o negative");
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("La muestra de audio está vacía");
    if (buffer.length > 20 * 1024 * 1024) throw new Error("La muestra supera el máximo de 20 MB");
    const directory = join(this.directory(id), "samples", kind);
    await mkdir(directory, { recursive: true });
    const name = `${this.now().getTime()}-${randomUUID()}-${safeFileName(originalName, "sample.wav")}`;
    await writeFile(join(directory, name), buffer);
    const metadata = await this.readMetadata(id);
    await this.writeMetadata({ ...metadata, updatedAt: this.now().toISOString() });
    return this.describe(id);
  }

  async remove(id) {
    await this.readMetadata(id);
    await rm(this.directory(id), { recursive: true });
  }
}
