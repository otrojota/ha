import assert from "node:assert/strict";
import test from "node:test";
import { SpotifyConnect } from "./spotify-connect.js";

test("explica cuando el usuario no está autorizado en la aplicación Spotify", async () => {
  const store = {
    getSpotifyIntegration: () => ({ accessToken: "token", expiresAt: Date.now() + 60_000 })
  };
  const spotify = new SpotifyConnect({
    store,
    fetchImpl: async () => new Response(
      "The user is not registered for this application. Please check your settings on https://developer.spotify.com/dashboard.",
      { status: 403 }
    )
  });

  await assert.rejects(
    () => spotify.discover(),
    /Settings → Users Management/
  );
});

test("incorpora el dispositivo activo aunque no aparezca en devices", async () => {
  const store = { getSpotifyIntegration: () => ({ accessToken: "token", expiresAt: Date.now() + 60_000 }) };
  let request = 0;
  const spotify = new SpotifyConnect({
    store,
    fetchImpl: async () => {
      request += 1;
      if (request === 1) return Response.json({ devices: [] });
      return Response.json({ device: { id: "dmpa6", name: "Eversolo DMP-A6", type: "Speaker", is_active: true } });
    }
  });

  const devices = await spotify.discover();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, "Eversolo DMP-A6");
  assert.equal(devices[0].active, true);
});

test("reproduce un artista como contexto continuo sin crear playlists", async () => {
  const spotify = new SpotifyConnect({ store: { getSpotifyIntegration: () => ({}) } });
  const requests = [];
  spotify.api = async (path, options = {}) => {
    requests.push({ path, options });
    if (path.startsWith("/search")) return { artists: { items: [{ name: "Pink Floyd", type: "artist", uri: "spotify:artist:pink" }] } };
    return null;
  };
  const result = await spotify.play("Pink Floyd", "dmp", { mode: "artist", shuffle: true });
  const play = requests.find((request) => request.path.startsWith("/me/player/play"));
  assert.deepEqual(JSON.parse(play.options.body), { context_uri: "spotify:artist:pink" });
  assert.equal(requests.some((request) => request.path.startsWith("/me/playlists")), false);
  assert.equal(result.item.type, "artist");
});

test("prioriza una pista al buscar un título y artista concretos", async () => {
  const spotify = new SpotifyConnect({ store: { getSpotifyIntegration: () => ({}) } });
  const requests = [];
  spotify.api = async (path, options = {}) => {
    requests.push({ path, options });
    if (path.startsWith("/search")) return {
      artists: { items: [{ name: "Elton John", type: "artist", uri: "spotify:artist:elton" }] },
      tracks: { items: [{ name: "Candle in the Wind", type: "track", uri: "spotify:track:candle" }] },
      albums: { items: [] }, playlists: { items: [] }
    };
    return null;
  };

  const result = await spotify.play("Candle in the Wind Elton John", "dmp", { mode: "auto", shuffle: false });

  const play = requests.find((request) => request.path.startsWith("/me/player/play"));
  assert.deepEqual(JSON.parse(play.options.body), { uris: ["spotify:track:candle"] });
  assert.equal(requests.some((request) => request.path === "/me/player/shuffle?state=false&device_id=dmp"), true);
  assert.equal(result.item.name, "Candle in the Wind");
});

test("normaliza los metadatos de la reproducción actual", async () => {
  const spotify = new SpotifyConnect({ store: { getSpotifyIntegration: () => ({}) } });
  spotify.api = async () => ({
    is_playing: true, progress_ms: 42000, shuffle_state: false, repeat_state: "off",
    device: { id: "dmp", name: "DMP-A6", type: "AVR", volume_percent: 55, supports_volume: true },
    item: { id: "sundown", name: "Sundown", type: "track", duration_ms: 213000, uri: "spotify:track:sundown", external_ids: { isrc: "USWB17400001" }, artists: [{ name: "Gordon Lightfoot" }], album: { name: "Sundown", images: [{ url: "https://i.scdn.co/sundown.jpg", width: 640, height: 640 }] } }
  });
  const playback = await spotify.getPlayback();
  assert.equal(playback.item.name, "Sundown");
  assert.equal(playback.item.id, "sundown");
  assert.equal(playback.item.isrc, "USWB17400001");
  assert.deepEqual(playback.item.artists, ["Gordon Lightfoot"]);
  assert.equal(playback.device.name, "DMP-A6");
  assert.equal(playback.progressMs, 42000);
  assert.deepEqual(playback.item.artwork, { url: "https://i.scdn.co/sundown.jpg", width: 640, height: 640, source: "spotify" });
});

test("confirma la pausa por estado cuando el receptor devuelve Restriction violated", async () => {
  const spotify = new SpotifyConnect({ store: { getSpotifyIntegration: () => ({}) } });
  spotify.api = async (path) => {
    if (path.startsWith("/me/player/pause")) throw new Error("Player command failed: Restriction violated");
    if (path === "/me/player") return { is_playing: false, device: { id: "dmp", name: "DMP-A6" }, item: null };
    throw new Error(`Ruta inesperada: ${path}`);
  };

  const result = await spotify.pause("dmp");

  assert.deepEqual(result, { status: "paused", confirmation: "verified_after_provider_error" });
});

test("enriquece y almacena la portada cuando playback no incluye imágenes", async () => {
  const spotify = new SpotifyConnect({ store: { getSpotifyIntegration: () => ({}) } });
  let trackRequests = 0;
  spotify.api = async (path) => {
    if (path.startsWith("/tracks/")) {
      trackRequests += 1;
      return { album: { images: [{ url: "https://i.scdn.co/cover.jpg", width: 300, height: 300 }] } };
    }
    return { is_playing: true, item: { id: "track1", name: "Song", type: "track", artists: [], album: { name: "Album" } } };
  };
  const first = await spotify.getPlayback();
  const second = await spotify.getPlayback();
  assert.equal(first.item.artwork.url, "https://i.scdn.co/cover.jpg");
  assert.equal(second.item.artwork.url, "https://i.scdn.co/cover.jpg");
  assert.equal(trackRequests, 1);
});

test("normaliza la canción actual y la cola de Spotify", async () => {
  const spotify = new SpotifyConnect({ store: { getSpotifyIntegration: () => ({}) } });
  spotify.api = async () => ({
    currently_playing: { name: "Actual", type: "track", artists: [{ name: "Artista" }], album: { name: "Álbum" }, duration_ms: 1000, uri: "spotify:track:a" },
    queue: [{ name: "Siguiente", type: "track", artists: [{ name: "Otro" }], album: { name: "Otro álbum" }, duration_ms: 2000, uri: "spotify:track:b" }]
  });
  const result = await spotify.getQueue();
  assert.equal(result.current.name, "Actual");
  assert.equal(result.queue[0].name, "Siguiente");
  assert.deepEqual(result.queue[0].artists, ["Otro"]);
});

test("no agrega nuevamente una pista que ya está en la cola", async () => {
  const spotify = new SpotifyConnect({ store: { getSpotifyIntegration: () => ({}) } });
  let added = false;
  spotify.api = async (path) => {
    if (path.startsWith("/search")) return { tracks: { items: [{ name: "Candle in the Wind", uri: "spotify:track:candle", artists: [{ name: "Elton John" }] }] } };
    if (path === "/me/player/queue") return { currently_playing: null, queue: [{ name: "Candle in the Wind", uri: "spotify:track:candle", artists: [] }] };
    if (path.startsWith("/me/player/queue?")) { added = true; return null; }
    throw new Error(`Ruta inesperada: ${path}`);
  };

  const result = await spotify.addToQueue("Candle in the Wind", "dmp");

  assert.equal(result.alreadyQueued, true);
  assert.equal(added, false);
});

test("informa la limitación de Spotify sin alterar reproducción ni cola", async () => {
  const spotify = new SpotifyConnect({ store: { getSpotifyIntegration: () => ({}) } });
  spotify.getQueue = async () => ({ current: null, queue: [{ uri: "spotify:track:a" }, { uri: "spotify:track:b" }] });
  spotify.api = async () => { throw new Error("No debe ejecutar comandos de reproducción"); };

  const result = await spotify.clearQueue("dmp");

  assert.equal(result.status, "unsupported");
  assert.equal(result.cleared, 0);
  assert.equal(result.remaining, 2);
  assert.match(result.message, /Web API no ofrece/);
});

test("espera el destino transferido y fuerza play si el receptor queda pausado", async () => {
  const spotify = new SpotifyConnect({ store: { getSpotifyIntegration: () => ({}) }, sleep: async () => {} });
  const requests = [];
  let playbackRead = 0;
  spotify.api = async (path, options = {}) => {
    requests.push({ path, options });
    if (path === "/me/player" && options.method === "PUT") return null;
    if (path.startsWith("/me/player/play")) return null;
    if (path === "/me/player") {
      playbackRead += 1;
      if (playbackRead === 1) return { device: { id: "mac" }, is_playing: false };
      if (playbackRead === 2) return { device: { id: "dmp" }, is_playing: false };
      return { device: { id: "dmp" }, is_playing: true };
    }
    throw new Error(`Ruta inesperada: ${path}`);
  };

  const result = await spotify.transfer("dmp", true);

  assert.deepEqual(result, { status: "playing", action: "transferred" });
  assert.equal(requests.some((request) => request.path === "/me/player/play?device_id=dmp"), true);
  assert.equal(playbackRead, 3);
});
