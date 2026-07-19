import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PROTOCOL_VERSION } from "@ha/contracts";

const SERVER_KEYS = ["id", "name", "address", "port", "protocolVersion", "httpUrl", "webSocketUrl", "speechToTextUrl", "musicApiUrl"];

function validateSavedServer(server, selectedServerId) {
  if (!server || typeof server !== "object" || Array.isArray(server)) return null;
  if (Object.keys(server).some((key) => !SERVER_KEYS.includes(key))) throw new Error("lastServer contiene campos desconocidos");
  if (server.id !== selectedServerId || typeof server.name !== "string" || !server.name.trim()) throw new Error("lastServer no coincide con selectedServerId");
  if (server.protocolVersion !== PROTOCOL_VERSION) throw new Error(`El servidor guardado usa protocolo ${server.protocolVersion || "desconocido"}`);
  if (typeof server.address !== "string" || !server.address || !Number.isInteger(server.port)) throw new Error("lastServer no contiene un endpoint válido");
  for (const key of ["httpUrl", "webSocketUrl", "speechToTextUrl", "musicApiUrl"]) {
    if (typeof server[key] !== "string" || !server[key]) throw new Error(`lastServer.${key} es obligatorio`);
  }
  return server;
}

export async function readSatelliteServerConfig(path, log = () => {}) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const selectedServerId = typeof value.selectedServerId === "string" ? value.selectedServerId : null;
    if (Object.keys(value).some((key) => !["selectedServerId", "lastServer"].includes(key))) throw new Error("La selección contiene campos desconocidos");
    const lastServer = validateSavedServer(value.lastServer, selectedServerId);
    return { selectedServerId, lastServer };
  } catch (error) {
    if (error.code !== "ENOENT") log("warn", "No se pudo leer la selección de servidor", { path, error: error.message });
    return { selectedServerId: null, lastServer: null };
  }
}

export async function writeSatelliteServerConfig(path, config) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  const server = config.lastServer;
  const lastServer = server ? {
    id: server.id,
    name: server.name,
    address: server.address,
    port: server.port,
    protocolVersion: PROTOCOL_VERSION,
    httpUrl: server.httpUrl,
    webSocketUrl: server.webSocketUrl,
    speechToTextUrl: server.speechToTextUrl,
    musicApiUrl: server.musicApiUrl
  } : null;
  await writeFile(temporaryPath, `${JSON.stringify({ selectedServerId: config.selectedServerId || null, lastServer }, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}
