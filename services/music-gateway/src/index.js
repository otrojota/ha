import { createServer } from "node:http";
import { env, jsonLog } from "@ha/shared";
import { MusicGateway, SimulatorMusicProvider } from "./music-gateway.js";
import { DestinationStore } from "./destination-store.js";
import { DestinationService } from "./destination-service.js";
import { SpotifyConnect } from "./spotify-connect.js";
import { MusicCreditsService } from "./music-credits.js";

const port = Number(env("MUSIC_GATEWAY_PORT", "3100"));
const gateway = new MusicGateway(new SimulatorMusicProvider());
const destinationStore = new DestinationStore(env("MUSIC_CONFIG_PATH", "dev/server/config/music.json"));
await destinationStore.load();
const spotifyConnect = new SpotifyConnect({ store: destinationStore });
const musicCredits = new MusicCreditsService({
  localPath: env("MUSIC_CREDITS_PATH", "dev/server/config/music-credits.json"),
  userAgent: env("MUSIC_METADATA_USER_AGENT", "HA-Voice-Assistant/0.1"),
  log: jsonLog
});
const destinationService = new DestinationService({
  store: destinationStore,
  spotifyConnect,
  log: jsonLog
});

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

async function commandDestination(command = {}) {
  const destination = command.destination
    ? await destinationStore.setActiveDestination(command.destination)
    : destinationStore.getActiveDestination();
  if (!destination) throw new Error("No hay un destino de música activo");
  if (destination.source !== "spotify-connect") throw new Error(`El destino ${destination.name} todavía no permite control de reproducción`);
  return destination;
}

createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  response.setHeader("Content-Type", "application/json");
  try {
    if (request.method === "OPTIONS") return response.end();
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    let result;
    if (request.method === "GET" && url.pathname === "/health") result = { status: "ok", provider: "spotify" };
    else if (request.method === "GET" && url.pathname === "/v1/playback") result = gateway.getPlayback();
    else if (request.method === "POST" && url.pathname === "/v1/play") result = gateway.play(await readJson(request));
    else if (request.method === "POST" && url.pathname === "/v1/pause") result = gateway.pause();
    else if (request.method === "POST" && url.pathname === "/v1/music/play") {
      const command = await readJson(request);
      const destination = command.destination
        ? await destinationStore.setActiveDestination(command.destination)
        : destinationStore.getActiveDestination();
      if (!destination) throw new Error("No hay un destino de música activo");
      if (destination.source !== "spotify-connect") throw new Error(`El destino ${destination.name} todavía no permite control de reproducción`);
      result = { ...(await spotifyConnect.play(command.query, destination.providerDeviceId, {
        mode: command.mode, searches: command.searches, shuffle: command.shuffle
      })), destination };
    }
    else if (request.method === "POST" && url.pathname === "/v1/music/pause") {
      const command = await readJson(request);
      const destination = command.destination
        ? await destinationStore.setActiveDestination(command.destination)
        : destinationStore.getActiveDestination();
      if (!destination) throw new Error("No hay un destino de música activo");
      if (destination.source !== "spotify-connect") throw new Error(`El destino ${destination.name} todavía no permite control de reproducción`);
      result = { ...(await spotifyConnect.pause(destination.providerDeviceId)), destination };
    }
    else if (request.method === "GET" && url.pathname === "/v1/music/playback") result = await spotifyConnect.getPlayback();
    else if (request.method === "POST" && url.pathname === "/v1/music/resume") {
      const destination = await commandDestination(await readJson(request));
      result = { ...(await spotifyConnect.resume(destination.providerDeviceId)), destination };
    }
    else if (request.method === "POST" && url.pathname === "/v1/music/next") {
      const destination = await commandDestination(await readJson(request));
      result = { ...(await spotifyConnect.next(destination.providerDeviceId)), destination };
    }
    else if (request.method === "POST" && url.pathname === "/v1/music/previous") {
      const destination = await commandDestination(await readJson(request));
      result = { ...(await spotifyConnect.previous(destination.providerDeviceId)), destination };
    }
    else if (request.method === "POST" && url.pathname === "/v1/music/volume") {
      const command = await readJson(request);
      const destination = await commandDestination(command);
      let volumePercent = command.volumePercent;
      if (volumePercent === undefined && command.changePercent !== undefined) {
        const playback = await spotifyConnect.getPlayback();
        if (playback.device?.volumePercent === null || playback.device?.volumePercent === undefined) throw new Error("Spotify no informó el volumen actual");
        volumePercent = playback.device.volumePercent + Number(command.changePercent);
      }
      if (volumePercent === undefined) throw new Error("Indica un volumen o un cambio relativo");
      result = { ...(await spotifyConnect.setVolume(destination.providerDeviceId, volumePercent)), destination };
    }
    else if (request.method === "POST" && url.pathname === "/v1/music/queue") {
      const command = await readJson(request);
      const destination = await commandDestination(command);
      result = { ...(await spotifyConnect.addToQueue(command.query, destination.providerDeviceId)), destination };
    }
    else if (request.method === "GET" && url.pathname === "/v1/music/queue") result = await spotifyConnect.getQueue();
    else if (request.method === "DELETE" && url.pathname === "/v1/music/queue") {
      const destination = destinationStore.getActiveDestination();
      if (!destination) throw new Error("No hay un destino de música activo");
      result = { ...(await spotifyConnect.clearQueue(destination.providerDeviceId)), destination };
    }
    else if (request.method === "GET" && url.pathname === "/v1/music/credits") result = await musicCredits.getCurrentCredits(await spotifyConnect.getPlayback());
    else if (request.method === "POST" && url.pathname === "/v1/music/transfer") {
      const command = await readJson(request);
      if (!command.destination) throw new Error("Indica el destino al que quieres transferir la música");
      const destination = await commandDestination(command);
      result = { ...(await spotifyConnect.transfer(destination.providerDeviceId, command.play !== false)), destination };
    }
    else if (request.method === "GET" && url.pathname === "/v1/destinations") result = destinationService.getState();
    else if (request.method === "POST" && url.pathname === "/v1/destinations/discover") result = await destinationService.discover();
    else if (request.method === "POST" && url.pathname === "/v1/destinations") result = await destinationStore.addDestination(await readJson(request));
    else if (request.method === "PUT" && url.pathname === "/v1/destinations/active") {
      const update = await readJson(request);
      result = await destinationStore.setActiveDestination(update.id || update.query);
    }
    else if (request.method === "PUT" && url.pathname === "/v1/integrations/spotify") {
      result = await destinationStore.updateSpotifyIntegration(await readJson(request));
      result = spotifyConnect.publicConfig();
    }
    else if (request.method === "POST" && url.pathname === "/v1/integrations/spotify/authorize") {
      result = { authorizationUrl: await spotifyConnect.authorizationUrl() };
    }
    else if (request.method === "GET" && url.pathname === "/v1/integrations/spotify/callback") {
      await spotifyConnect.completeAuthorization(Object.fromEntries(url.searchParams));
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      return response.end("<!doctype html><html lang=es><meta charset=utf-8><title>Spotify conectado</title><body style='font-family:system-ui;background:#101820;color:white;padding:3rem'><h1>Spotify conectado</h1><p>La cuenta quedó autorizada. Ya puedes cerrar esta ventana y buscar dispositivos desde el display.</p></body></html>");
    }
    else if (request.method === "PUT" && url.pathname.startsWith("/v1/destinations/")) {
      result = await destinationStore.updateDestination(decodeURIComponent(url.pathname.slice("/v1/destinations/".length)), await readJson(request));
    }
    else { response.statusCode = 404; result = { error: "not_found" }; }
    response.end(JSON.stringify(result));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: "invalid_request", message: error.message }));
  }
}).listen(port, "0.0.0.0", () => jsonLog("info", "Music Gateway iniciado", { port, provider: "spotify" }));
