import { readFile, rename, writeFile } from "node:fs/promises";

const [path, serverPath] = process.argv.slice(2);
if (!path || !serverPath) throw new Error("Faltan rutas de configuración del servidor");

try {
  const previous = JSON.parse(await readFile(path, "utf8"));
  const current = {
    activeDestinationIds: previous.activeDestinationIds && !Array.isArray(previous.activeDestinationIds) ? previous.activeDestinationIds : {},
    activeSourceIds: previous.activeSourceIds && !Array.isArray(previous.activeSourceIds) ? previous.activeSourceIds : {}
  };
  const temporary = `${path}.v2.tmp`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o660 });
  await rename(temporary, path);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

try {
  const previous = JSON.parse(await readFile(serverPath, "utf8"));
  const location = previous.location || {};
  const current = {
    locale: previous.locale || "es-CL",
    timeZone: previous.timeZone || "America/Santiago",
    location: {
      city: location.city || "Valparaíso",
      region: location.region || "Valparaíso",
      country: location.country || "Chile",
      countryCode: location.countryCode || "CL",
      latitude: Number.isFinite(location.latitude) ? location.latitude : -33.0472,
      longitude: Number.isFinite(location.longitude) ? location.longitude : -71.6127,
      timeZone: location.timeZone || previous.timeZone || "America/Santiago",
      source: location.source === "ip" ? "ip" : "manual",
      ...(typeof location.ip === "string" ? { ip: location.ip } : {})
    },
    conversationMemory: {
      enabled: previous.conversationMemory?.enabled !== false,
      maxTurns: previous.conversationMemory?.maxTurns ?? 10,
      maxCharacters: previous.conversationMemory?.maxCharacters ?? 12000,
      idleTimeoutMinutes: previous.conversationMemory?.idleTimeoutMinutes ?? 15
    },
    webSearch: {
      enabled: previous.webSearch?.enabled !== false,
      searxngUrl: previous.webSearch?.searxngUrl || "http://127.0.0.1:8888",
      maxResultsToTry: previous.webSearch?.maxResultsToTry ?? 3,
      maxContentCharacters: previous.webSearch?.maxContentCharacters ?? 6000
    },
    llm: {
      provider: previous.llm?.provider || "ollama",
      baseUrl: previous.llm?.baseUrl || "http://127.0.0.1:11434",
      model: previous.llm?.model || "qwen3.5:9b",
      temperature: previous.llm?.temperature ?? 0.1,
      contextLength: previous.llm?.contextLength ?? 8192,
      timeoutMs: previous.llm?.timeoutMs ?? 120000,
      think: previous.llm?.think === true,
      keepAlive: previous.llm?.keepAlive || "30m"
    },
    homeAutomation: {
      homeAssistant: {
        enabled: previous.homeAutomation?.homeAssistant?.enabled === true,
        baseUrl: previous.homeAutomation?.homeAssistant?.baseUrl || "http://127.0.0.1:8123",
        timeoutMs: previous.homeAutomation?.homeAssistant?.timeoutMs ?? 10000
      }
    }
  };
  const temporary = `${serverPath}.v2.tmp`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o660 });
  await rename(temporary, serverPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
