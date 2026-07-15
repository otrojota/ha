import { createServer } from "node:http";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env, jsonLog } from "@ha/shared";
import { DestinationStore } from "./destination-store.js";
import { MusicAssistantProvider } from "./music-assistant-provider.js";

const port = Number(env("MUSIC_GATEWAY_PORT", "3100"));
const provider = new MusicAssistantProvider({
  baseUrl: env("MUSIC_ASSISTANT_URL", "http://127.0.0.1:8095"),
  token: env("MUSIC_ASSISTANT_TOKEN", ""),
  timeoutMs: Number(env("MUSIC_ASSISTANT_TIMEOUT_MS", "30000"))
});
const store = new DestinationStore(env("MUSIC_CONFIG_PATH", "dev/server/config/music.json"));
const musicAssistantEnvPath = env("MUSIC_ASSISTANT_ENV_PATH", "dev/server/.music-assistant.env");
const volumeOverrides = new Map();
await store.load();

function effectivePlayerVolume(player) {
  if (!player) return player;
  const override = volumeOverrides.get(player.id);
  if (!override) return player;
  const reported = player.volumePercent;
  if (reported === override.requested || (reported !== null && reported !== undefined && reported !== override.reportedBefore)) {
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

async function state() {
  const [players, sources] = await Promise.all([provider.getPlayers(), provider.getSources()]);
  const destinations = store.decorate(players.map(effectivePlayerVolume));
  const activeSource = store.resolveSource(sources);
  return {
    provider: { id: "music-assistant", name: "Music Assistant", url: provider.baseUrl },
    activeDestinationId: destinations.find((item) => item.active)?.id || null,
    destinations,
    activeSourceId: activeSource?.id || null,
    sources: sources.map((source) => ({ ...source, active: source.id === activeSource?.id })),
    summary: {
      total: destinations.length,
      available: destinations.filter((item) => item.available && item.enabled !== false).length,
      sources: sources.filter((item) => item.available).length
    }
  };
}

async function destination(query, { activate = true } = {}) {
  const players = (await provider.getPlayers()).map(effectivePlayerVolume);
  if (activate && query) return store.setActive(players, query);
  const result = store.resolve(players, query);
  if (!result) throw new Error("No hay un destino activo en Music Assistant");
  return result;
}

async function source(query, { activate = true } = {}) {
  const sources = await provider.getSources();
  if (activate && query) return store.setActiveSource(sources, query);
  return store.resolveSource(sources, query);
}

async function playbackFor(command = {}) {
  const target = await destination(command.destination, { activate: Boolean(command.destination) });
  return { ...effectivePlaybackVolume(await provider.getPlayback(target.id)), destination: target };
}

async function activateDestination(query) {
  const players = (await provider.getPlayers()).map(effectivePlayerVolume);
  const previous = store.resolve(players);
  const target = store.resolve(players, query);
  if (!target) throw new Error("Music Assistant no tiene destinos habilitados");
  if (!target.available) throw new Error(`El destino ${target.alias || target.name} no está disponible`);

  let transferredPlayback = null;
  if (previous && previous.id !== target.id) {
    const current = effectivePlaybackVolume(await provider.getPlayback(previous.id));
    if (current.item) {
      transferredPlayback = effectivePlaybackVolume(await provider.transfer(previous.id, target.id, current.status === "playing"));
    }
  }
  const active = await store.setActive(players, target.id);
  return { ...active, transferred: Boolean(transferredPlayback), playback: transferredPlayback };
}

createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  try {
    if (request.method === "OPTIONS") return response.end();
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/v1/artwork") {
      const path = url.searchParams.get("path");
      if (!path) throw new Error("Falta la ruta de la portada");
      const artwork = await provider.getArtwork(path, url.searchParams.get("provider"));
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
      const current = await state();
      result = { activeSourceId: current.activeSourceId, sources: current.sources };
    }
    else if (request.method === "PUT" && url.pathname === "/v1/sources/active") {
      const body = await readJson(request);
      result = await store.setActiveSource(await provider.getSources(), body.id || body.query);
    }
    else if (request.method === "GET" && url.pathname === "/v1/destinations") result = await state();
    else if (request.method === "POST" && url.pathname === "/v1/destinations/discover") result = await state();
    else if (request.method === "PUT" && url.pathname === "/v1/destinations/active") {
      const body = await readJson(request);
      result = await activateDestination(body.id || body.query);
    }
    else if (request.method === "PUT" && url.pathname.startsWith("/v1/destinations/")) {
      result = await store.update(await provider.getPlayers(), decodeURIComponent(url.pathname.slice(17)), await readJson(request));
    }
    else if (request.method === "GET" && url.pathname === "/v1/music/playback") result = await playbackFor();
    else if (request.method === "POST" && url.pathname === "/v1/music/play") {
      const command = await readJson(request);
      const target = await destination(command.destination, { activate: Boolean(command.destination) });
      const selectedSource = await source(command.source, { activate: Boolean(command.source) });
      result = { ...(await provider.play({ ...command, playerId: target.id, sourceId: selectedSource?.id })), destination: target, source: selectedSource };
    }
    else if (request.method === "POST" && ["pause", "resume", "next", "previous"].some((action) => url.pathname === `/v1/music/${action}`)) {
      const action = url.pathname.split("/").pop();
      const command = await readJson(request);
      const target = await destination(command.destination, { activate: Boolean(command.destination) });
      result = { ...(await provider[action](target.id)), destination: target };
    }
    else if (request.method === "POST" && url.pathname === "/v1/music/volume") {
      const command = await readJson(request);
      const target = await destination(command.destination, { activate: Boolean(command.destination) });
      let volume = command.volumePercent;
      if (volume === undefined && command.changePercent !== undefined) volume = Number(target.volumePercent || 0) + Number(command.changePercent);
      if (!Number.isFinite(Number(volume))) throw new Error("Indica un volumen o cambio relativo válido");
      const requested = Math.max(0, Math.min(100, Math.round(Number(volume))));
      const reportedBefore = volumeOverrides.get(target.id)?.reportedBefore ?? target.volumePercent;
      volumeOverrides.set(target.id, { requested, reportedBefore });
      try {
        result = { ...effectivePlaybackVolume(await provider.setVolume(target.id, requested)), destination: { ...target, volumePercent: requested } };
      } catch (error) {
        volumeOverrides.delete(target.id);
        throw error;
      }
    }
    else if (request.method === "POST" && url.pathname === "/v1/music/queue") {
      const command = await readJson(request);
      const target = await destination(command.destination, { activate: Boolean(command.destination) });
      result = { ...(await provider.addToQueue(target.id, command.query)), destination: target };
    }
    else if (request.method === "GET" && url.pathname === "/v1/music/queue") {
      const target = await destination();
      result = { ...(await provider.getQueue(target.id)), destination: target };
    }
    else if (request.method === "DELETE" && url.pathname === "/v1/music/queue") {
      const target = await destination();
      result = { ...(await provider.clearQueue(target.id)), destination: target };
    }
    else if (request.method === "GET" && url.pathname === "/v1/music/credits") {
      const current = await playbackFor();
      result = { item: current.item, credits: [], message: "Music Assistant no informó créditos adicionales para este elemento" };
    }
    else if (request.method === "POST" && url.pathname === "/v1/music/transfer") {
      const command = await readJson(request);
      if (!command.destination) throw new Error("Indica el destino al que quieres transferir la música");
      const players = await provider.getPlayers();
      const source = store.resolve(players);
      const target = await store.setActive(players, command.destination);
      result = { ...(source && source.id !== target.id ? await provider.transfer(source.id, target.id, command.play !== false) : await provider.getPlayback(target.id)), destination: target };
    }
    else { response.statusCode = 404; result = { error: "not_found" }; }
    response.end(JSON.stringify(result));
  } catch (error) {
    response.statusCode = error.name === "TimeoutError" ? 503 : 400;
    response.end(JSON.stringify({ error: "music_assistant_error", message: error.message }));
  }
}).listen(port, "0.0.0.0", () => jsonLog("info", "Music Gateway iniciado", { port, provider: "music-assistant", url: provider.baseUrl }));
