import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultConfig = {
  name: "Asistente",
  wakeWordEnabled: true,
  wakeWordMode: "vosk",
  wakeWordModelId: null,
  wakeWordTrainingMode: false,
  connectedPowerDeviceId: null
};

export function normalizeWakeWordSelection(mode, modelId) {
  const normalizedMode = mode == null ? "vosk" : String(mode).trim();
  if (!["vosk", "model"].includes(normalizedMode)) {
    throw new Error("El método de activación debe ser Vosk o un modelo entrenado");
  }
  if (normalizedMode === "vosk") return { wakeWordMode: "vosk", wakeWordModelId: null };
  const normalizedId = String(modelId || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(normalizedId)) {
    throw new Error("Selecciona un modelo de wake word válido");
  }
  return { wakeWordMode: "model", wakeWordModelId: normalizedId };
}

export function normalizeConnectedPowerDeviceId(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^switch\.[a-z0-9_]+$/.test(value)) {
    throw new Error("El enchufe conectado debe ser una entidad switch de Home Assistant");
  }
  return value;
}

export function normalizeAssistantName(value) {
  if (typeof value !== "string") throw new Error("El nombre debe ser texto");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 40) throw new Error("El nombre debe tener entre 2 y 40 caracteres");
  if (!/^[\p{L}][\p{L}\p{M}' -]*$/u.test(name)) throw new Error("Usa solamente letras, espacios, apóstrofes o guiones");
  return name;
}

export async function readAssistantConfig(path, log) {
  try {
    const stored = JSON.parse(await readFile(path, "utf8"));
    const wakeWordSelection = normalizeWakeWordSelection(stored.wakeWordMode, stored.wakeWordModelId);
    return {
      name: normalizeAssistantName(stored.name),
      wakeWordEnabled: stored.wakeWordEnabled !== false,
      ...wakeWordSelection,
      wakeWordTrainingMode: wakeWordSelection.wakeWordMode === "model" && stored.wakeWordTrainingMode === true,
      connectedPowerDeviceId: normalizeConnectedPowerDeviceId(stored.connectedPowerDeviceId)
    };
  } catch (error) {
    if (error.code !== "ENOENT") log("warn", "No se pudo leer la configuración del asistente", { error: error.message });
    return { ...defaultConfig };
  }
}

export async function writeAssistantConfig(path, config) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function validateAssistantNameWithVosk(name, { python, scriptPath, modelPath }) {
  const normalizedName = normalizeAssistantName(name);
  const { stderr } = await execFileAsync(python, [
    scriptPath,
    "--model", modelPath,
    "--wake-word", normalizedName,
    "--validate-only"
  ], { timeout: 30_000, maxBuffer: 2_000_000 });
  const missing = [...stderr.matchAll(/Ignoring word missing in vocabulary:\s*'([^']+)'/g)].map((match) => match[1]);
  if (missing.length) throw new Error(`Vosk no reconoce: ${[...new Set(missing)].join(", ")}`);
  return normalizedName;
}
