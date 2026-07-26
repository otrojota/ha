import { createServer } from "node:http";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath, env, jsonLog } from "@ha/shared";
import { DestinationStore } from "./destination-store.js";
import { MusicAssistantProvider } from "./music-assistant-provider.js";

const port = Number(env("MUSIC_GATEWAY_PORT", "3100"));
const provider = new MusicAssistantProvider({
  baseUrl: env("MUSIC_ASSISTANT_URL", "http://127.0.0.1:8095"),
  token: env("MUSIC_ASSISTANT_TOKEN", ""),
  timeoutMs: Number(env("MUSIC_ASSISTANT_TIMEOUT_MS", "30000")),
  artistAlbumConcurrency: Number(env("MUSIC_ARTIST_ALBUM_CONCURRENCY", "4")),
  artistAlbumTimeoutMs: Number(env("MUSIC_ARTIST_ALBUM_TIMEOUT_MS", "8000")),
  log: jsonLog
});
const store = new DestinationStore(env("MUSIC_CONFIG_PATH", configPath("/etc/ha/server/music.json", "dev/server/config/music.json")));
const musicAssistantEnvPath = env("MUSIC_ASSISTANT_ENV_PATH", configPath("/etc/ha/server/music-assistant.env", "dev/server/.music-assistant.env"));
const volumeOverrides = new Map();
const VOLUME_CONFIRMATION_TIMEOUT_MS = 5000;
const catalogRefreshMs = Math.max(10_000, Number(env("MUSIC_CATALOG_REFRESH_MS", "60000")) || 60_000);
let catalog = { players: [], sources: [], refreshedAt: null, stale: true, error: null };
let catalogRefreshPromise = null;
await store.load();

async function refreshCatalog() {
  if (catalogRefreshPromise) return catalogRefreshPromise;
  catalogRefreshPromise = Promise.all([provider.getPlayers(), provider.getSources()])
    .then(([players, sources]) => {
      catalog = { players, sources, refreshedAt: new Date().toISOString(), stale: false, error: null };
      return catalog;
    })
    .catch((error) => {
      catalog = { ...catalog, stale: true, error: error.message };
      if (!catalog.refreshedAt) throw error;
      return catalog;
    })
    .finally(() => { catalogRefreshPromise = null; });
  return catalogRefreshPromise;
}

async function musicCatalog() {
  if (!catalog.refreshedAt) await refreshCatalog();
  return catalog;
}

setInterval(() => void refreshCatalog().catch((error) => jsonLog("warn", "No se pudo refrescar el catálogo de Music Assistant", { error: error.message })), catalogRefreshMs).unref();

function effectivePlayerVolume(player) {
  if (!player) return player;
  const override = volumeOverrides.get(player.id);
  if (!override) return player;
  const reported = player.volumePercent;
  if (reported === override.requested) {
    volumeOverrides.delete(player.id);
    return player;
  }
  if (Date.now() - override.requestedAt >= VOLUME_CONFIRMATION_TIMEOUT_MS) {
    volumeOverrides.delete(player.id);
    return player;
  }
  return { ...player, volumePercent: override.requested, volumeStatePending: true };
}

function effectivePlaybackVolume(playback) {
  if (!playback?.device) return playback;
  const effective = effectivePlayerVolume({ id: playback.device.id, volumePercent: playback.device.volumePercent });
  return effective === playback.device ? playback : {
    ...playback,
    device: { ...playback.device, volumePercent: effective.volumePercent, volumeStatePending: effective.volumeStatePending }
  };
}

async function saveMusicAssistantToken(token) {
  await mkdir(dirname(musicAssistantEnvPath), { recursive: true });
  const temporary = `${musicAssistantEnvPath}.tmp`;
  await writeFile(temporary, `MUSIC_ASSISTANT_TOKEN=${token}\n`, { mode: 0o600 });
  await rename(temporary, musicAssistantEnvPath);
  await chmod(musicAssistantEnvPath, 0o600);
}

async function integrationStatus() {
  try {
    const health = await provider.health();
    return { connected: true, requiresAuthentication: false, ...health };
  } catch (error) {
    return {
      connected: false,
      requiresAuthentication: provider.authenticationRequired || error.code === "MUSIC_ASSISTANT_AUTH_REQUIRED" || /401|authentic|token|login|autorización/i.test(error.message),
      url: provider.baseUrl,
      message: error.message
    };
  }
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

function requireScope(request) {
  const satelliteId = String(request.headers["x-satellite-id"] || "").trim();
  if (!satelliteId) throw new Error("Falta el encabezado X-Satellite-Id");
  return satelliteId;
}

async function state(scope) {
  const { players, sources, refreshedAt, stale, error } = await musicCatalog();
  const destinations = store.decorate(players.map(effectivePlayerVolume), scope);
  const activeSource = store.resolveSource(sources, undefined, scope);
  return {
    provider: { id: "music-assistant", name: "Music Assistant", url: provider.baseUrl },
    activeDestinationId: destinations.find((item) => item.active)?.id || null,
    destinations,
    activeSourceId: activeSource?.id || null,
    sources: sources.map((source) => ({ ...source, active: source.id === activeSource?.id })),
    summary: {
      total: destinations.length,
      available: destinations.filter((item) => item.available).length,
      sources: sources.filter((item) => item.available).length
    },
    refreshedAt,
    stale,
    error
  };
}

async function destination(query, { activate = true, scope } = {}) {
  const players = (await musicCatalog()).players.map(effectivePlayerVolume);
  if (activate && query) return store.setActive(players, query, scope);
  const result = store.resolve(players, query, scope);
  if (!result) throw new Error("No hay un destino activo en Music Assistant");
  return result;
}

async function source(query, { activate = true, scope } = {}) {
  const sources = (await musicCatalog()).sources;
  if (activate && query) return store.setActiveSource(sources, query, scope);
  return store.resolveSource(sources, query, scope);
}

function sourceForItem(sources, item) {
  const providerId = String(item?.provider || "").toLowerCase();
  if (!providerId) return null;
  const providerDomain = providerId.split("--")[0];
  return sources.find((candidate) => {
    const id = String(candidate.id || "").toLowerCase();
    const domain = String(candidate.domain || "").toLowerCase();
    return id === providerId || domain === providerId || id === providerDomain || domain === providerDomain;
  }) || null;
}

async function playbackFor(command = {}, scope) {
  const target = await destination(command.destination, { activate: Boolean(command.destination), scope });
  const playback = effectivePlaybackVolume(await provider.getPlayback(target.id));
  const sources = (await musicCatalog()).sources;
  return { ...playback, destination: target, source: sourceForItem(sources, playback.item) || store.resolveSource(sources, undefined, scope) };
}

async function activateDestination(query, scope) {
  const players = (await musicCatalog()).players.map(effectivePlayerVolume);
  const target = store.resolve(players, query, scope);
  if (!target) throw new Error("Music Assistant no tiene destinos habilitados");
  if (!target.available) throw new Error(`El destino ${target.name} no está disponible`);
  return store.setActive(players, target.id, scope);
}

createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Satellite-Id");
  response.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  try {
    if (request.method === "OPTIONS") return response.end();
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/v1/artwork") {
      const path = url.searchParams.get("path");
      const proxyId = url.searchParams.get("proxyId");
      if (!path && !proxyId) throw new Error("Falta la ruta o el identificador de la portada");
      const artwork = await provider.getArtwork(path, url.searchParams.get("provider"), proxyId);
      response.statusCode = artwork.status;
      response.setHeader("Content-Type", artwork.headers.get("content-type") || "application/octet-stream");
      response.setHeader("Cache-Control", artwork.headers.get("cache-control") || "public, max-age=3600");
      response.end(Buffer.from(await artwork.arrayBuffer()));
      return;
    }
    let result;
    if (request.method === "GET" && url.pathname === "/health") result = await integrationStatus();
    else if (request.method === "GET" && url.pathname === "/v1/integration/music-assistant") result = await integrationStatus();
    else if (request.method === "POST" && url.pathname === "/v1/integration/music-assistant/login") {
      const credentials = await readJson(request);
      if (!String(credentials.username || "").trim() || !String(credentials.password || "")) throw new Error("Indica usuario y contraseña de Music Assistant");
      const token = await provider.login(String(credentials.username).trim(), String(credentials.password));
      await saveMusicAssistantToken(token);
      result = { ...(await integrationStatus()), tokenStored: true };
      jsonLog("info", "Music Gateway autenticado con Music Assistant; token persistido", { path: musicAssistantEnvPath });
    }
    else if (request.method === "GET" && url.pathname === "/v1/sources") {
      const scope = requireScope(request);
      const current = await state(scope);
      result = { activeSourceId: current.activeSourceId, sources: current.sources };
    }
    else if (request.method === "PUT" && url.pathname === "/v1/sources/active") {
      const scope = requireScope(request);
      const body = await readJson(request);
      result = await store.setActiveSource((await musicCatalog()).sources, body.target, scope);
    }
    else if (request.method === "GET" && url.pathname === "/v1/destinations") result = await state(requireScope(request));
    else if (request.method === "POST" && url.pathname === "/v1/destinations/discover") { await refreshCatalog(); result = await state(requireScope(request)); }
    else if (request.method === "PUT" && url.pathname === "/v1/destinations/active") {
      const scope = requireScope(request);
      const body = await readJson(request);
      result = await activateDestination(body.target, scope);
    }
    else if (request.method === "GET" && url.pathname === "/v1/music/playback") {
      const scope = requireScope(request);
      result = await playbackFor({ destination: url.searchParams.get("destination") || undefined }, scope);
    }
    else if (request.method === "GET" && url.pathname === "/v1/music/radios") {
      requireScope(request);
      const radios = await provider.getLibraryRadios();
      result = { radios, total: radios.length };
    }
    else if (request.method === "GET" && url.pathname === "/v1/music/playlists") {
      requireScope(request);
      const playlists = await provider.getLibraryPlaylists();
      result = { playlists, total: playlists.length };
    }
    else if (request.method === "POST" && url.pathname === "/v1/music/play") {
      const scope = requireScope(request);
      const command = await readJson(request);
      const target = await destination(command.destination, { activate: Boolean(command.destination), scope });
      const selectedSource = await source(command.source, { activate: Boolean(command.source), scope });
      const playback = await provider.play({
        ...command,
        playerId: target.id,
        sourceId: command.mode === "radio" ? undefined : selectedSource?.id
      });
      const sources = (await musicCatalog()).sources;
      const actualSource = sourceForItem(sources, playback.item) || selectedSource;
      if (actualSource && actualSource.id !== selectedSource?.id) await store.setActiveSource(sources, actualSource.id, scope);
      result = { ...playback, destination: target, source: actualSource };
    }
    else if (request.method === "POST" && ["pause", "resume", "next", "previous"].some((action) => url.pathname === `/v1/music/${action}`)) {
      const scope = requireScope(request);
      const action = url.pathname.split("/").pop();
      const command = await readJson(request);
      const target = await destination(command.destination, { activate: Boolean(command.destination), scope });
      result = { ...(await provider[action](target.id)), destination: target };
    }
    else if (request.method === "POST" && url.pathname === "/v1/music/volume") {
      const scope = requireScope(request);
      const command = await readJson(request);
      const target = await destination(command.destination, { activate: Boolean(command.destination), scope });
      let volume = command.volumePercent;
      if (volume === undefined && command.changePercent !== undefined) volume = Number(target.volumePercent || 0) + Number(command.changePercent);
      if (!Number.isFinite(Number(volume))) throw new Error("Indica un volumen o cambio relativo válido");
      const requested = Math.max(0, Math.min(100, Math.round(Number(volume))));
      volumeOverrides.set(target.id, { requested, requestedAt: Date.now() });
      try {
        result = {
          ...effectivePlaybackVolume(await provider.setVolume(target.id, requested)),
          requestedVolumePercent: requested,
          destination: { ...target, volumePercent: requested }
        };
      } catch (error) {
        volumeOverrides.delete(target.id);
        throw error;
      }
    }
    else if (request.method === "POST" && url.pathname === "/v1/music/queue") {
      const scope = requireScope(request);
      const command = await readJson(request);
      const target = await destination(command.destination, { activate: Boolean(command.destination), scope });
      result = { ...(await provider.addToQueue(target.id, command.query)), destination: target };
    }
    else if (request.method === "GET" && url.pathname === "/v1/music/queue") {
      const scope = requireScope(request);
      const target = await destination(url.searchParams.get("destination") || undefined, { activate: false, scope });
      result = { ...(await provider.getQueue(target.id)), destination: target };
    }
    else if (request.method === "DELETE" && url.pathname === "/v1/music/queue") {
      const scope = requireScope(request);
      const target = await destination(undefined, { scope });
      result = { ...(await provider.clearQueue(target.id)), destination: target };
    }
    else if (request.method === "GET" && url.pathname === "/v1/music/credits") {
      const scope = requireScope(request);
      const current = await playbackFor({}, scope);
      result = { item: current.item, credits: [], message: "Music Assistant no informó créditos adicionales para este elemento" };
    }
    else if (request.method === "POST" && url.pathname === "/v1/music/transfer") {
      const scope = requireScope(request);
      const command = await readJson(request);
      if (!command.destination) throw new Error("Indica el destino al que quieres transferir la música");
      const players = (await musicCatalog()).players;
      const source = store.resolve(players, undefined, scope);
      const target = await store.setActive(players, command.destination, scope);
      result = { ...(source && source.id !== target.id ? await provider.transfer(source.id, target.id, command.play !== false) : await provider.getPlayback(target.id)), destination: target };
    }
    else { response.statusCode = 404; result = { error: "not_found" }; }
    response.end(JSON.stringify(result));
  } catch (error) {
    response.statusCode = error.name === "TimeoutError" ? 503 : 400;
    response.end(JSON.stringify({ error: "music_assistant_error", message: error.message }));
  }
}).listen(port, "0.0.0.0", () => jsonLog("info", "Music Gateway iniciado", { port, provider: "music-assistant", url: provider.baseUrl }));
