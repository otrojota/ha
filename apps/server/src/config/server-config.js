import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const defaults = {
  locale: "es-CL",
  timeZone: "America/Santiago",
  location: {
    city: "Valparaíso",
    region: "Valparaíso",
    country: "Chile",
    countryCode: "CL",
    latitude: -33.0472,
    longitude: -71.6127,
    timeZone: "America/Santiago",
    source: "manual"
  },
  conversationMemory: {
    enabled: true,
    maxTurns: 10,
    maxCharacters: 12000,
    idleTimeoutMinutes: 15
  },
  webSearch: {
    enabled: true,
    searxngUrl: "http://127.0.0.1:8888",
    maxResultsToTry: 3,
    maxContentCharacters: 6000
  },
  llm: {
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3.5:9b",
    temperature: 0.1,
    contextLength: 8192,
    timeoutMs: 120000,
    think: false,
    keepAlive: "30m"
  },
  homeAutomation: {
    homeAssistant: { enabled: false, baseUrl: "http://127.0.0.1:8123", timeoutMs: 10000 }
  }
};

function requireKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} debe ser un objeto`);
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.join(",") !== allowed.join(",")) throw new Error(`${name} debe contener exactamente: ${allowed.join(", ")}`);
}

export function validateHomeAssistantConfig(value = {}) {
  const baseUrl = new URL(String(value.baseUrl || defaults.homeAutomation.homeAssistant.baseUrl));
  if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error("Home Assistant debe usar HTTP o HTTPS");
  const timeoutMs = Number(value.timeoutMs ?? 10000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error("Home Assistant timeoutMs no es válido");
  return { enabled: value.enabled === true, baseUrl: baseUrl.toString().replace(/\/$/, ""), timeoutMs };
}

const providerDefaults = {
  ollama: { baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:9b" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  "openai-compatible": { baseUrl: "", model: "" },
  "github-models": { baseUrl: "https://models.github.ai/inference", model: "openai/gpt-4.1" }
};

export function validateLlmConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("llm debe ser un objeto");
  const provider = String(value.provider || "").trim();
  if (!providerDefaults[provider]) throw new Error("llm.provider no es compatible");
  const fallback = providerDefaults[provider];
  const baseUrlValue = String(value.baseUrl ?? fallback.baseUrl).trim();
  const model = String(value.model ?? fallback.model).trim();
  if (!baseUrlValue) throw new Error("llm.baseUrl es obligatorio");
  if (!model) throw new Error("llm.model es obligatorio");
  const baseUrl = new URL(baseUrlValue);
  if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error("llm.baseUrl debe usar HTTP o HTTPS");
  const temperature = Number(value.temperature ?? defaults.llm.temperature);
  const contextLength = Number(value.contextLength ?? defaults.llm.contextLength);
  const timeoutMs = Number(value.timeoutMs ?? defaults.llm.timeoutMs);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("llm.temperature debe estar entre 0 y 2");
  if (!Number.isInteger(contextLength) || contextLength < 1024 || contextLength > 1000000) throw new Error("llm.contextLength no es válido");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error("llm.timeoutMs no es válido");
  return {
    provider,
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    model,
    temperature,
    contextLength,
    timeoutMs,
    think: provider === "ollama" && value.think === true,
    keepAlive: provider === "ollama" ? String(value.keepAlive || defaults.llm.keepAlive).trim() : defaults.llm.keepAlive
  };
}

export function validateLocation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("location debe ser un objeto");
  for (const key of ["city", "region", "country", "timeZone"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`location.${key} debe ser un texto no vacío`);
  }
  if (!Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90) throw new Error("location.latitude debe estar entre -90 y 90");
  if (!Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180) throw new Error("location.longitude debe estar entre -180 y 180");
  const timeZone = new Intl.DateTimeFormat("es", { timeZone: value.timeZone.trim() }).resolvedOptions().timeZone;
  const countryCode = typeof value.countryCode === "string" ? value.countryCode.trim().toUpperCase() : "";
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) throw new Error("location.countryCode debe tener dos letras");
  return {
    city: value.city.trim(), region: value.region.trim(), country: value.country.trim(), countryCode,
    latitude: value.latitude, longitude: value.longitude, timeZone,
    source: value.source === "ip" ? "ip" : "manual",
    ...(typeof value.ip === "string" ? { ip: value.ip } : {})
  };
}

function validate(config) {
  requireKeys(config, Object.keys(defaults), "La configuración del servidor");
  requireKeys(config.location, [...Object.keys(defaults.location), ...(typeof config.location?.ip === "string" ? ["ip"] : [])], "location");
  requireKeys(config.conversationMemory, Object.keys(defaults.conversationMemory), "conversationMemory");
  requireKeys(config.webSearch, Object.keys(defaults.webSearch), "webSearch");
  requireKeys(config.llm, Object.keys(defaults.llm), "llm");
  requireKeys(config.homeAutomation, ["homeAssistant"], "homeAutomation");
  requireKeys(config.homeAutomation.homeAssistant, Object.keys(defaults.homeAutomation.homeAssistant), "homeAutomation.homeAssistant");
  if (typeof config.locale !== "string" || !config.locale.trim()) throw new Error("locale debe ser un texto no vacío");
  if (typeof config.timeZone !== "string" || !config.timeZone.trim()) throw new Error("timeZone debe ser un texto no vacío");
  const locale = Intl.getCanonicalLocales(config.locale.trim())[0];
  const timeZone = new Intl.DateTimeFormat(locale, { timeZone: config.timeZone.trim() }).resolvedOptions().timeZone;
  const location = validateLocation(config.location);
  const conversationMemory = config.conversationMemory;
  if (typeof conversationMemory.enabled !== "boolean") throw new Error("conversationMemory.enabled debe ser booleano");
  if (!Number.isInteger(conversationMemory.maxTurns) || conversationMemory.maxTurns < 1 || conversationMemory.maxTurns > 50) throw new Error("conversationMemory.maxTurns debe estar entre 1 y 50");
  if (!Number.isInteger(conversationMemory.maxCharacters) || conversationMemory.maxCharacters < 1000 || conversationMemory.maxCharacters > 100000) throw new Error("conversationMemory.maxCharacters debe estar entre 1000 y 100000");
  if (typeof conversationMemory.idleTimeoutMinutes !== "number" || conversationMemory.idleTimeoutMinutes < 1 || conversationMemory.idleTimeoutMinutes > 1440) throw new Error("conversationMemory.idleTimeoutMinutes debe estar entre 1 y 1440");
  const webSearch = config.webSearch;
  if (typeof webSearch.enabled !== "boolean") throw new Error("webSearch.enabled debe ser booleano");
  const searxngUrl = new URL(webSearch.searxngUrl);
  if (!["http:", "https:"].includes(searxngUrl.protocol)) throw new Error("webSearch.searxngUrl debe usar HTTP o HTTPS");
  if (!Number.isInteger(webSearch.maxResultsToTry) || webSearch.maxResultsToTry < 1 || webSearch.maxResultsToTry > 10) throw new Error("webSearch.maxResultsToTry debe estar entre 1 y 10");
  if (!Number.isInteger(webSearch.maxContentCharacters) || webSearch.maxContentCharacters < 500 || webSearch.maxContentCharacters > 20000) throw new Error("webSearch.maxContentCharacters debe estar entre 500 y 20000");
  const llm = validateLlmConfig(config.llm);
  const homeAutomation = { homeAssistant: validateHomeAssistantConfig(config.homeAutomation?.homeAssistant) };
  return {
    locale,
    timeZone,
    location,
    conversationMemory,
    webSearch: { ...webSearch, searxngUrl: searxngUrl.toString().replace(/\/$/, "") },
    llm,
    homeAutomation
  };
}

export async function writeServerConfig(path, config) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function readServerConfig(path, log = () => {}) {
  try {
    return validate(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") {
      log("warn", "No existe la configuración del servidor; se usarán valores predeterminados", { path, ...defaults });
      return { ...defaults };
    }
    throw new Error(`Configuración del servidor inválida en ${path}: ${error.message}`);
  }
}
