import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultConfig = { name: "Asistente", wakeWordEnabled: true };

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
    return {
      name: normalizeAssistantName(stored.name),
      wakeWordEnabled: stored.wakeWordEnabled !== false
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
