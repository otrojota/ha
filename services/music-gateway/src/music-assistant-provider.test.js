import test from "node:test";
import assert from "node:assert/strict";
import { MusicAssistantProvider } from "./music-assistant-provider.js";

function response(result) { return { ok: true, json: async () => ({ message_id: "1", result }) }; }

test("usa la API de Music Assistant para buscar y reemplazar la cola", async () => {
  const commands = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    commands.push(request);
    if (request.command === "music/search") return response({ tracks: [{ uri: "library://track/1", name: "Uno", media_type: "track" }] });
    if (request.command === "player_queues/play_media" || request.command === "player_queues/shuffle") return response(null);
    if (request.command === "players/all") return response([{ player_id: "speaker", name: "Satélite", playback_state: "playing" }]);
    if (request.command === "player_queues/all") return response([{ queue_id: "speaker", state: "playing", current_item: { media_item: { name: "Uno", uri: "library://track/1" } } }]);
    throw new Error(request.command);
  };
  const provider = new MusicAssistantProvider({ fetchImpl });
  const result = await provider.play({ query: "Uno", playerId: "speaker", shuffle: false });
  assert.equal(result.item.name, "Uno");
  assert.equal(commands.find((item) => item.command === "player_queues/play_media").args.option, "replace");
});

test("desactiva shuffle antes de iniciar un álbum completo", async () => {
  const commands = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    commands.push(request);
    if (request.command === "music/search") return response({ albums: [{ uri: "spotify://album/wall", name: "The Wall", media_type: "album" }] });
    if (request.command === "player_queues/shuffle" || request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all") return response([{ player_id: "dmp", name: "Eversolo", playback_state: "playing" }]);
    if (request.command === "player_queues/all") return response([{ queue_id: "dmp", state: "playing", current_item: { media_item: { name: "In the Flesh?" } } }]);
    throw new Error(request.command);
  } });

  const result = await provider.play({ query: "The Wall Pink Floyd", playerId: "dmp", mode: "album", shuffle: true });

  const shuffleIndex = commands.findIndex((item) => item.command === "player_queues/shuffle");
  const playIndex = commands.findIndex((item) => item.command === "player_queues/play_media");
  assert.ok(shuffleIndex >= 0 && shuffleIndex < playIndex);
  assert.equal(commands[shuffleIndex].args.shuffle_enabled, false);
  assert.equal(result.item.name, "In the Flesh?");
});

test("limita la búsqueda al origen activo de Music Assistant", async () => {
  let searchProviders;
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.command === "music/search") {
      searchProviders = request.args.providers;
      return response({ artists: [{ uri: "tidal://artist/1", name: "Peter Gabriel", media_type: "artist" }] });
    }
    if (request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all") return response([]);
    if (request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });
  await provider.play({ query: "Peter Gabriel", playerId: "eversolo", sourceId: "tidal--home", mode: "artist" });
  assert.deepEqual(searchProviders, ["tidal--home"]);
});

test("solicita aclaración cuando una letra hablada coincide con nombres de artista distintos", async () => {
  const commands = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); commands.push(request.command);
    if (request.command === "music/search") return response({ artists: [
      { uri: "tidal://artist/project-j", name: "Proyecto J", media_type: "artist" },
      { uri: "tidal://artist/proyecto-jota", name: "Proyecto Jota", media_type: "artist" }
    ] });
    throw new Error(`No debía ejecutar ${request.command}`);
  } });

  const result = await provider.play({ query: "Proyecto J", playerId: "speaker", mode: "artist" });

  assert.equal(result.clarificationRequired, true);
  assert.deepEqual(result.choices.map((choice) => choice.name), ["Proyecto J", "Proyecto Jota"]);
  assert.deepEqual(commands, ["music/search"]);
});

test("reproduce directamente una coincidencia escrita exacta aunque exista un nombre parecido", async () => {
  const commands = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); commands.push(request.command);
    if (request.command === "music/search") return response({ artists: [
      { uri: "tidal://artist/project-j", name: "Proyecto J", media_type: "artist" },
      { uri: "tidal://artist/proyecto-jota", name: "Proyecto Jota", media_type: "artist" }
    ] });
    if (request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all") return response([]);
    if (request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });

  await provider.play({ query: "Proyecto Jota", playerId: "speaker", mode: "artist" });

  assert.ok(commands.includes("player_queues/play_media"));
});

test("no repite ni declara fallida una reproducción aceptada si demora leer el estado", async () => {
  const commands = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    commands.push(request.command);
    if (request.command === "music/search") return response({ artists: [{ uri: "spotify://artist/pink", name: "Pink Floyd", media_type: "artist" }] });
    if (request.command === "player_queues/play_media" || request.command === "player_queues/shuffle") return response(null);
    throw new Error("estado temporalmente no disponible");
  } });

  const result = await provider.play({ query: "Pink Floyd", playerId: "dmp", mode: "artist", shuffle: true });

  assert.equal(commands.filter((command) => command === "player_queues/play_media").length, 1);
  assert.equal(result.status, "playing");
  assert.equal(result.item.name, "Pink Floyd");
  assert.equal(result.statePending, true);
});

test("acepta respuestas JSON nulas de comandos sin lanzar TypeError", async () => {
  const provider = new MusicAssistantProvider({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => null }) });
  assert.equal(await provider.command("players/cmd/play", {}), null);
});

test("conserva el detalle de un error HTTP de Music Assistant", async () => {
  const provider = new MusicAssistantProvider({ fetchImpl: async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error_code: 7, details: "Player Eversolo is not available" })
  }) });
  await assert.rejects(provider.command("player_queues/play_media"), /Player Eversolo is not available/);
});

test("envía control de volumen al reproductor MA", async () => {
  const commands = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); commands.push(request);
    if (request.command === "players/all") return response([{ player_id: "speaker", name: "Satélite", volume_level: 80 }]);
    if (request.command === "player_queues/all") return response([]);
    return response(null);
  } });
  await provider.setVolume("speaker", 120);
  assert.deepEqual(commands[0].args, { player_id: "speaker", volume_level: 100 });
});

test("inicia sesión y reemplaza la sesión por un token de larga duración", async () => {
  const requests = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body, authorization: options.headers.Authorization });
    if (url.endsWith("/auth/login")) return { ok: true, json: async () => ({ success: true, token: "session-token" }) };
    return response("long-lived-token");
  } });
  assert.equal(await provider.login("admin", "secret-password"), "long-lived-token");
  assert.equal(provider.token, "long-lived-token");
  assert.deepEqual(requests[0].body, {
    provider_id: "builtin",
    credentials: { username: "admin", password: "secret-password" },
    device_name: "HA Music Gateway bootstrap"
  });
  assert.equal(requests[1].body.command, "auth/token/create");
  assert.equal(requests[1].authorization, "Bearer session-token");
  assert.equal(provider.authenticationRequired, false);
});

test("un 401 invalida el token y activa el estado de reautenticación", async () => {
  const provider = new MusicAssistantProvider({
    token: "expired-token",
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: "Unauthorized" }) })
  });
  await assert.rejects(provider.getPlayers(), (error) => error.code === "MUSIC_ASSISTANT_AUTH_REQUIRED");
  assert.equal(provider.token, "");
  assert.equal(provider.authenticationRequired, true);
});

test("normaliza portadas de MA como rutas del proxy de Music Gateway", () => {
  const provider = new MusicAssistantProvider({});
  const item = provider.normalizeItem({
    name: "Tema",
    image_url: "http://127.0.0.1:8095/imageproxy?path=https%3A%2F%2Fi.scdn.co%2Fcover.jpg&provider=spotify--123"
  });
  assert.equal(item.artworkUrl, "/v1/artwork?path=https%3A%2F%2Fi.scdn.co%2Fcover.jpg&provider=spotify--123");
});

test("conserva el origen externo de un favorito guardado en la biblioteca de MA", () => {
  const provider = new MusicAssistantProvider({});
  const item = provider.normalizeItem({
    uri: "library://track/42",
    name: "Tema favorito",
    provider: "library",
    provider_mappings: [
      { provider_domain: "spotify", provider_instance: "spotify--home", item_id: "42" }
    ]
  });

  assert.equal(item.provider, "spotify--home");
  assert.equal(item.library, true);
});

test("solicita la portada a MA usando autenticación", async () => {
  let received;
  const provider = new MusicAssistantProvider({ token: "valid-token", fetchImpl: async (url, options) => {
    received = { url: url.toString(), authorization: options.headers.Authorization };
    return { ok: true, status: 200, headers: new Headers({ "content-type": "image/jpeg" }) };
  } });
  await provider.getArtwork("https://i.scdn.co/cover.jpg", "spotify--123");
  assert.match(received.url, /\/imageproxy\?/);
  assert.match(received.url, /provider=spotify--123/);
  assert.equal(received.authorization, "Bearer valid-token");
});
