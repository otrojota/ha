import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const emptyConfig = { assignments: {} };

function validate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("La configuración TTS debe ser un objeto");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "assignments") throw new Error("La configuración TTS debe contener exactamente assignments");
  if (!value.assignments || typeof value.assignments !== "object" || Array.isArray(value.assignments)) throw new Error("assignments debe ser un objeto");
  const assignments = {};
  for (const [satelliteId, voiceId] of Object.entries(value.assignments)) {
    const scope = String(satelliteId).trim();
    const voice = String(voiceId).trim();
    if (!scope || !voice) throw new Error("Cada asignación necesita satelliteId y voiceId");
    assignments[scope] = voice;
  }
  return { assignments };
}

export class VoiceConfigStore {
  constructor({ path, log = () => {} }) {
    this.path = path;
    this.log = log;
    this.config = structuredClone(emptyConfig);
  }

  async initialize() {
    try {
      this.config = validate(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.log("warn", "No existe configuración TTS; se iniciará sin asignaciones", { path: this.path });
    }
    return this.snapshot();
  }

  snapshot() { return structuredClone(this.config); }

  voiceFor(satelliteId, availableVoices) {
    const requested = this.config.assignments[String(satelliteId || "").trim()];
    if (requested && availableVoices.some((voice) => voice.id === requested)) return requested;
    return availableVoices[0]?.id || null;
  }

  async assign(satelliteId, voiceId, availableVoices) {
    const scope = String(satelliteId || "").trim();
    const voice = String(voiceId || "").trim();
    if (!scope) throw new Error("satelliteId es obligatorio");
    if (!availableVoices.some((item) => item.id === voice)) throw new Error("La voz seleccionada no está disponible");
    this.config.assignments[scope] = voice;
    await this.persist();
    return voice;
  }

  async persist() {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.config, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }
}
