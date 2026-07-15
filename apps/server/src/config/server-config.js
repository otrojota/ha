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
  }
};

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
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("La configuración del servidor debe ser un objeto");
  if (typeof config.locale !== "string" || !config.locale.trim()) throw new Error("locale debe ser un texto no vacío");
  if (typeof config.timeZone !== "string" || !config.timeZone.trim()) throw new Error("timeZone debe ser un texto no vacío");
  const locale = Intl.getCanonicalLocales(config.locale.trim())[0];
  const timeZone = new Intl.DateTimeFormat(locale, { timeZone: config.timeZone.trim() }).resolvedOptions().timeZone;
  const location = validateLocation({ ...defaults.location, ...(config.location || {}) });
  const conversationMemory = { ...defaults.conversationMemory, ...(config.conversationMemory || {}) };
  if (typeof conversationMemory.enabled !== "boolean") throw new Error("conversationMemory.enabled debe ser booleano");
  if (!Number.isInteger(conversationMemory.maxTurns) || conversationMemory.maxTurns < 1 || conversationMemory.maxTurns > 50) throw new Error("conversationMemory.maxTurns debe estar entre 1 y 50");
  if (!Number.isInteger(conversationMemory.maxCharacters) || conversationMemory.maxCharacters < 1000 || conversationMemory.maxCharacters > 100000) throw new Error("conversationMemory.maxCharacters debe estar entre 1000 y 100000");
  if (typeof conversationMemory.idleTimeoutMinutes !== "number" || conversationMemory.idleTimeoutMinutes < 1 || conversationMemory.idleTimeoutMinutes > 1440) throw new Error("conversationMemory.idleTimeoutMinutes debe estar entre 1 y 1440");
  const webSearch = { ...defaults.webSearch, ...(config.webSearch || {}) };
  if (typeof webSearch.enabled !== "boolean") throw new Error("webSearch.enabled debe ser booleano");
  const searxngUrl = new URL(webSearch.searxngUrl);
  if (!["http:", "https:"].includes(searxngUrl.protocol)) throw new Error("webSearch.searxngUrl debe usar HTTP o HTTPS");
  if (!Number.isInteger(webSearch.maxResultsToTry) || webSearch.maxResultsToTry < 1 || webSearch.maxResultsToTry > 10) throw new Error("webSearch.maxResultsToTry debe estar entre 1 y 10");
  if (!Number.isInteger(webSearch.maxContentCharacters) || webSearch.maxContentCharacters < 500 || webSearch.maxContentCharacters > 20000) throw new Error("webSearch.maxContentCharacters debe estar entre 500 y 20000");
  return {
    locale,
    timeZone,
    location,
    conversationMemory,
    webSearch: { ...webSearch, searxngUrl: searxngUrl.toString().replace(/\/$/, "") }
  };
}

export async function writeServerConfig(path, config) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function readServerConfig(path = "dev/server/config/server.json", log = () => {}) {
  try {
    return validate({ ...defaults, ...JSON.parse(await readFile(path, "utf8")) });
  } catch (error) {
    if (error.code === "ENOENT") {
      log("warn", "No existe la configuración del servidor; se usarán valores predeterminados", { path, ...defaults });
      return { ...defaults };
    }
    throw new Error(`Configuración del servidor inválida en ${path}: ${error.message}`);
  }
}
