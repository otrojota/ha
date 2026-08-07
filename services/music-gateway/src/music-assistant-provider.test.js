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

test("arma y reemplaza una cola aleatoria al pedir música general de un artista", async () => {
  const commands = [];
  const provider = new MusicAssistantProvider({ randomImpl: () => 0, artistQueueSize: 3, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    commands.push(request);
    if (request.command === "music/search") return response({ artists: [{
      uri: "tidal://artist/pink-floyd", item_id: "pink-floyd", provider: "tidal", name: "Pink Floyd", media_type: "artist"
    }] });
    if (request.command === "music/artists/artist_albums") return response([
      { uri: "tidal://album/a", item_id: "a", provider: "tidal" },
      { uri: "tidal://album/b", item_id: "b", provider: "tidal" }
    ]);
    if (request.command === "music/albums/album_tracks") return response(request.args.item_id === "a" ? [
      { uri: "tidal://track/1", name: "Uno" }, { uri: "tidal://track/2", name: "Dos" }
    ] : [{ uri: "tidal://track/3", name: "Tres" }, { uri: "tidal://track/4", name: "Cuatro" }]);
    if (request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all" || request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });

  await provider.play({ query: "Pink Floyd", playerId: "dmp", mode: "artist", shuffle: true });
  await provider.artistQueueFillPromises.get("dmp");

  const artistAlbums = commands.find((request) => request.command === "music/artists/artist_albums");
  assert.deepEqual(artistAlbums.args, { item_id: "pink-floyd", provider_instance_id_or_domain: "tidal" });
  assert.equal(commands.filter((request) => request.command === "music/albums/album_tracks").length, 2);
  const play = commands.find((request) => request.command === "player_queues/play_media");
  assert.equal(play.args.option, "replace");
  assert.match(play.args.media, /^tidal:\/\/track\//);
  assert.equal(commands.filter((request) => request.command === "player_queues/play_media").length, 3);
  assert.equal(commands.some((request) => request.command === "player_queues/shuffle"), false);
});

test("consulta los álbumes de un artista en paralelo sin superar el límite configurado", async () => {
  let active = 0;
  let maximumActive = 0;
  const albums = Array.from({ length: 12 }, (_, index) => ({
    uri: `tidal://album/${index}`, item_id: String(index), provider: "tidal", name: `Álbum ${index}`
  }));
  const provider = new MusicAssistantProvider({ artistAlbumConcurrency: 4, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.command === "music/search") return response({ artists: [{
      uri: "tidal://artist/pink-floyd", item_id: "pink-floyd", provider: "tidal", name: "Pink Floyd", media_type: "artist"
    }] });
    if (request.command === "music/artists/artist_albums") return response(albums);
    if (request.command === "music/albums/album_tracks") {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return response([{ uri: `tidal://track/${request.args.item_id}`, name: `Tema ${request.args.item_id}` }]);
    }
    return response({ queue_id: "speaker", current_item: { media_item: { uri: "tidal://track/0", name: "Tema 0" } } });
  } });

  await provider.play({ query: "Pink Floyd", playerId: "speaker", mode: "artist", shuffle: true });
  await provider.artistQueueFillPromises.get("speaker");

  assert.equal(maximumActive, 4);
});

test("evita repetir la primera canción y prioriza temas fuera de la lista anterior", async () => {
  const playedQueues = [];
  const provider = new MusicAssistantProvider({ randomImpl: () => 0, artistQueueSize: 2, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.command === "music/search") return response({ artists: [{
      uri: "library://artist/42", item_id: "42", provider: "library", name: "Artista", media_type: "artist"
    }] });
    if (request.command === "music/artists/artist_albums") return response([
      { uri: "library://album/1", name: "Uno" }, { uri: "library://album/2", name: "Dos" }
    ]);
    if (request.command === "music/albums/album_tracks") return response(request.args.item_id === "1" ? [
      { uri: "library://track/1", name: "Uno" }, { uri: "library://track/2", name: "Dos" }
    ] : [{ uri: "library://track/3", name: "Tres" }, { uri: "library://track/4", name: "Cuatro" }]);
    if (request.command === "player_queues/play_media") { playedQueues.push(request.args); return response(null); }
    if (request.command === "players/all" || request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });

  await provider.play({ query: "Artista", playerId: "speaker", mode: "artist", shuffle: true });
  await provider.artistQueueFillPromises.get("speaker");
  await provider.play({ query: "Artista", playerId: "speaker", mode: "artist", shuffle: true });
  await provider.artistQueueFillPromises.get("speaker");

  const replacements = playedQueues.filter((entry) => entry.option === "replace").map((entry) => entry.media);
  assert.equal(replacements.length, 2);
  assert.notEqual(replacements[1], replacements[0]);
});

test("cancela el rellenado anterior cuando una nueva reproducción reemplaza la cola", async () => {
  const queueCommands = [];
  let releaseOldAlbum;
  let oldAlbumStarted;
  const oldAlbumPending = new Promise((resolve) => { oldAlbumStarted = resolve; });
  const provider = new MusicAssistantProvider({ randomImpl: () => 0.999, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.command === "music/search") return response({ artists: [{
      uri: `tidal://artist/${request.args.search_query}`, item_id: request.args.search_query,
      provider: "tidal", name: request.args.search_query, media_type: "artist"
    }] });
    if (request.command === "music/artists/artist_albums") return response(request.args.item_id === "Anterior"
      ? [{ uri: "tidal://album/a1" }, { uri: "tidal://album/a2" }]
      : [{ uri: "tidal://album/b1" }]);
    if (request.command === "music/albums/album_tracks" && request.args.item_id === "a2") {
      oldAlbumStarted();
      return new Promise((resolve) => { releaseOldAlbum = () => resolve(response([{ uri: "tidal://track/a2", name: "A2" }])); });
    }
    if (request.command === "music/albums/album_tracks") return response([{
      uri: `tidal://track/${request.args.item_id}`, name: request.args.item_id
    }]);
    if (request.command === "player_queues/play_media") { queueCommands.push(request.args); return response(null); }
    throw new Error(request.command);
  } });

  await provider.play({ query: "Anterior", playerId: "speaker", mode: "artist" });
  const oldFill = provider.artistQueueFillPromises.get("speaker");
  await oldAlbumPending;
  await provider.play({ query: "Nueva", playerId: "speaker", mode: "artist" });
  releaseOldAlbum();
  await oldFill;

  const lastReplace = queueCommands.findLastIndex((entry) => entry.option === "replace");
  assert.equal(queueCommands[lastReplace].media, "tidal://track/b1");
  assert.equal(queueCommands.slice(lastReplace + 1).some((entry) => entry.media === "tidal://track/a2"), false);
});

test("usa el mapping del origen activo y omite álbumes retirados sin abortar la discografía", async () => {
  const commands = [];
  const warnings = [];
  const provider = new MusicAssistantProvider({ log: (...args) => warnings.push(args), fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); commands.push(request);
    if (request.command === "music/search") return response({ artists: [{
      uri: "library://artist/31", item_id: "31", provider: "library", name: "31 Minutos", media_type: "artist",
      provider_mappings: [{ item_id: "spotify-31", provider_instance: "spotify--home", provider_domain: "spotify", available: true }]
    }] });
    if (request.command === "music/artists/artist_albums") return response([
      { uri: "library://album/bad", name: "Retirado", provider_mappings: [
        { item_id: "tidal-bad", provider_instance: "tidal--home", provider_domain: "tidal", available: true },
        { item_id: "spotify-bad", provider_instance: "spotify--home", provider_domain: "spotify", available: true }
      ] },
      { uri: "library://album/good", name: "Disponible", provider_mappings: [
        { item_id: "spotify-good", provider_instance: "spotify--home", provider_domain: "spotify", available: true }
      ] }
    ]);
    if (request.command === "music/albums/album_tracks" && request.args.item_id === "spotify-bad") {
      return { ok: false, status: 500, json: async () => ({ error: { message: "MediaNotFoundError: álbum retirado" } }) };
    }
    if (request.command === "music/albums/album_tracks") return response([{ uri: "spotify://track/good", name: "Mi equilibrio espiritual" }]);
    if (request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all" || request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });

  await provider.play({ query: "31 Minutos", playerId: "speaker", sourceId: "spotify--home", mode: "artist", shuffle: true });
  await provider.artistQueueFillPromises.get("speaker");

  const albumsLookup = commands.find((request) => request.command === "music/artists/artist_albums");
  assert.deepEqual(albumsLookup.args, { item_id: "spotify-31", provider_instance_id_or_domain: "spotify--home" });
  assert.deepEqual(commands.filter((request) => request.command === "music/albums/album_tracks")
    .map((request) => request.args.provider_instance_id_or_domain), ["spotify--home", "spotify--home"]);
  assert.equal(commands.find((request) => request.command === "player_queues/play_media").args.media, "spotify://track/good");
  assert.match(warnings[0][2].error, /MediaNotFoundError/);
});

test("informa el detalle real cuando ningún álbum del artista está disponible", async () => {
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.command === "music/search") return response({ artists: [{ uri: "tidal://artist/31", name: "31 Minutos", media_type: "artist" }] });
    if (request.command === "music/artists/artist_albums") return response([{ uri: "tidal://album/bad", name: "Retirado" }]);
    if (request.command === "music/albums/album_tracks") return {
      ok: false, status: 500, json: async () => ({ error: { details: "MediaNotFoundError: Item not found" } })
    };
    throw new Error(request.command);
  } });

  await assert.rejects(provider.play({ query: "31 Minutos", playerId: "speaker", mode: "artist", shuffle: true }),
    /no pudo leer los álbumes.*MediaNotFoundError: Item not found/);
});

test("usa las pistas destacadas de MA para las más populares de un artista", async () => {
  const commands = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); commands.push(request);
    if (request.command === "music/search") return response({ artists: [{ uri: "tidal://artist/queen", name: "Queen", media_type: "artist" }] });
    if (request.command === "music/artists/artist_tracks") return response([
      { uri: "tidal://track/bohemian", name: "Bohemian Rhapsody" }, { uri: "tidal://track/radio", name: "Radio Ga Ga" }
    ]);
    if (request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all" || request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });

  await provider.play({ query: "Queen", playerId: "speaker", mode: "popular", shuffle: false });

  assert.deepEqual(commands.find((request) => request.command === "music/search").args.media_types, ["artist"]);
  assert.deepEqual(commands.find((request) => request.command === "player_queues/play_media").args.media,
    ["tidal://track/bohemian", "tidal://track/radio"]);
  assert.equal(commands.some((request) => request.command === "music/artists/artist_albums"), false);
});

test("reemplaza la cola con canciones parecidas entregadas por MA", async () => {
  const commands = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); commands.push(request);
    if (request.command === "music/search") return response({ tracks: [{ uri: "tidal://track/seed", name: "Semilla", media_type: "track" }] });
    if (request.command === "music/tracks/similar_tracks") return response([
      { uri: "tidal://track/similar-1", name: "Parecida 1" }, { uri: "tidal://track/similar-2", name: "Parecida 2" }
    ]);
    if (request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all" || request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });

  await provider.play({ query: "Semilla", playerId: "speaker", sourceId: "tidal--home", mode: "similar", shuffle: false });

  const similar = commands.find((request) => request.command === "music/tracks/similar_tracks");
  assert.deepEqual(similar.args.preferred_provider_instances, ["tidal--home"]);
  assert.equal(similar.args.allow_lookup, true);
  assert.deepEqual(commands.find((request) => request.command === "player_queues/play_media").args.media,
    ["tidal://track/similar-1", "tidal://track/similar-2"]);
});

test("respeta canción y álbum específicos sin construir una cola de artista", async () => {
  const commands = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    commands.push(request);
    if (request.command === "music/search") return response(request.args.media_types[0] === "album"
      ? { albums: [{ uri: "tidal://album/1", name: "Disco", media_type: "album" }] }
      : { tracks: [{ uri: "tidal://track/1", name: "Canción", media_type: "track" }] });
    if (request.command === "player_queues/play_media" || request.command === "player_queues/shuffle") return response(null);
    if (request.command === "players/all" || request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });

  await provider.play({ query: "Canción", playerId: "speaker", mode: "auto", shuffle: true });
  await provider.play({ query: "Disco", playerId: "speaker", mode: "album", shuffle: false });

  assert.equal(commands.some((request) => request.command === "music/artists/artist_tracks"), false);
  assert.deepEqual(commands.filter((request) => request.command === "player_queues/play_media").map((request) => request.args.media),
    ["tidal://track/1", "tidal://album/1"]);
});

test("avanza la cola activa y sólo confirma cuando cambió el elemento", async () => {
  let advanced = false;
  const commands = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    commands.push(request);
    if (request.command === "player_queues/next") { advanced = true; return response(null); }
    if (request.command === "players/all") return response([{ player_id: "speaker", name: "Satélite", playback_state: "playing" }]);
    if (request.command === "player_queues/all") return response([{
      queue_id: "speaker", state: "playing", current_index: advanced ? 1 : 0,
      current_item: { media_item: { uri: advanced ? "library://track/2" : "library://track/1", name: advanced ? "Dos" : "Uno", media_type: "track" } }
    }]);
    throw new Error(request.command);
  }});

  const result = await provider.next("speaker");

  assert.equal(result.item.name, "Dos");
  assert.equal(result.previousItem.name, "Uno");
  assert.deepEqual(commands.find((item) => item.command === "player_queues/next").args, { queue_id: "speaker" });
  assert.equal(commands.some((item) => item.command === "players/cmd/next"), false);
});

test("reanuda la cola existente sin reemplazarla", async () => {
  const commands = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); commands.push(request);
    if (request.command === "player_queues/all") return response([{ queue_id: "speaker", state: "paused", current_index: 2,
      current_item: { media_item: { uri: "library://track/3", name: "Tres" } } }]);
    if (request.command === "players/cmd/play") return response(null);
    if (request.command === "players/all") return response([{ player_id: "speaker", name: "Satélite", playback_state: "playing" }]);
    throw new Error(request.command);
  } });

  await provider.resume("speaker");

  assert.equal(commands.some((request) => request.command === "players/cmd/play"), true);
  assert.equal(commands.some((request) => request.command === "music/recently_played_items"), false);
});

test("recupera una reproducción reciente cuando el parlante no tiene cola", async () => {
  const commands = [];
  let hasQueue = false;
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); commands.push(request);
    if (request.command === "player_queues/all") return response(hasQueue
      ? [{ queue_id: "speaker", state: "playing", current_index: 0, current_item: { media_item: { uri: "library://track/recent", name: "Reciente" } } }]
      : [{ queue_id: "speaker", state: "idle", current_index: null, current_item: null }]);
    if (request.command === "music/recently_played_items") return response(request.args.queue_id
      ? [] : [{ uri: "library://track/recent", name: "Reciente", media_type: "track" }]);
    if (request.command === "player_queues/play_media") { hasQueue = true; return response(null); }
    if (request.command === "players/all") return response([{ player_id: "speaker", name: "Satélite", playback_state: "playing" }]);
    throw new Error(request.command);
  } });

  const result = await provider.resume("speaker");

  assert.equal(result.item.name, "Reciente");
  assert.deepEqual(commands.filter((request) => request.command === "music/recently_played_items").map((request) => request.args.queue_id),
    ["speaker", undefined]);
  assert.equal(commands.find((request) => request.command === "player_queues/play_media").args.media, "library://track/recent");
});

test("describe la canción actual y las próximas desde la cola", async () => {
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.command === "player_queues/all") return response([{
      queue_id: "speaker", current_index: 1,
      current_item: { media_item: { uri: "track:2", name: "Dos", media_type: "track" } }
    }]);
    if (request.command === "player_queues/items") return response([
      { media_item: { uri: "track:1", name: "Uno", media_type: "track" } },
      { media_item: { uri: "track:2", name: "Dos", media_type: "track" } },
      { media_item: { uri: "track:3", name: "Tres", media_type: "track" } }
    ]);
    throw new Error(request.command);
  }});

  const result = await provider.getQueue("speaker");

  assert.equal(result.current.name, "Dos");
  assert.equal(result.next.name, "Tres");
  assert.deepEqual(result.upcoming.map((item) => item.name), ["Tres"]);
});

test("limita la búsqueda al origen activo de Music Assistant", async () => {
  let searchProviders;
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.command === "music/search") {
      searchProviders = request.args.providers;
      return response({ artists: [{ uri: "tidal://artist/1", name: "Peter Gabriel", media_type: "artist" }] });
    }
    if (request.command === "music/artists/artist_albums") return response([{ uri: "tidal://album/1" }]);
    if (request.command === "music/albums/album_tracks") return response([{ uri: "tidal://track/1", name: "Solsbury Hill" }]);
    if (request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all") return response([]);
    if (request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });
  await provider.play({ query: "Peter Gabriel", playerId: "eversolo", sourceId: "tidal--home", mode: "artist" });
  assert.deepEqual(searchProviders, ["tidal--home"]);
});

test("busca una emisora sólo entre las radios de la biblioteca", async () => {
  const commands = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    commands.push(request);
    if (request.command === "music/radios/library_items") return response([{
      uri: "library://radio/42",
      name: "Radio Bío-Bío",
      media_type: "radio",
      provider: "library",
      provider_mappings: [{ provider_domain: "radiobrowser", provider_instance: "radiobrowser--chile", item_id: "biobio" }]
    }]);
    if (request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all") return response([]);
    if (request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });

  const result = await provider.play({ query: "BioBio", playerId: "satellite", mode: "radio" });

  const lookup = commands.find((item) => item.command === "music/radios/library_items");
  assert.equal(lookup.args.search, "BioBio");
  assert.equal(commands.some((item) => item.command === "music/search"), false);
  assert.equal(commands.find((item) => item.command === "player_queues/play_media").args.media, "library://radio/42");
  assert.equal(result.item.provider, "radiobrowser--chile");
});

test("no confunde la radio anterior con la recién solicitada mientras MA actualiza la cola", async () => {
  let playbackReads = 0;
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.command === "music/radios/library_items") return response([{
      uri: "library://radio/biobio-valparaiso", name: "BioBio Valparaíso", media_type: "radio", provider: "library"
    }]);
    if (request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all") return response([{ player_id: "speaker", name: "Parlante", playback_state: "playing" }]);
    if (request.command === "player_queues/all") {
      playbackReads += 1;
      const radio = playbackReads < 3
        ? { uri: "library://radio/futuro", name: "Futuro", media_type: "radio" }
        : { uri: "library://radio/biobio-valparaiso", name: "BioBio Valparaíso", media_type: "radio" };
      return response([{ queue_id: "speaker", state: "playing", current_item: { media_item: radio } }]);
    }
    throw new Error(`Comando inesperado: ${request.command}`);
  }});

  const result = await provider.play({ query: "Bio Bio Valparaíso", playerId: "speaker", mode: "radio" });

  assert.equal(result.item.name, "BioBio Valparaíso");
  assert.equal(result.item.uri, "library://radio/biobio-valparaiso");
  assert.equal(playbackReads, 3);
});

test("reintenta una radio sin el prefijo genérico hablado", async () => {
  const searches = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.command === "music/radios/library_items") {
      searches.push(request.args.search);
      return response(request.args.search === "BioBio Chile" ? [{
        uri: "library://radio/biobio", name: "BioBio Chile", media_type: "radio"
      }] : []);
    }
    if (request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all" || request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });

  const result = await provider.play({ query: "Radio BioBio Chile", playerId: "eversolo", mode: "radio" });

  assert.deepEqual(searches, ["Radio BioBio Chile", "BioBio Chile"]);
  assert.equal(result.item.name, "BioBio Chile");
});

test("encuentra una radio de biblioteca por nombre similar", async () => {
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.command === "music/radios/library_items") return response(request.args.search ? [] : [{
      uri: "library://radio/biobio-chile", name: "BioBio Chile", media_type: "radio"
    }]);
    if (request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all" || request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });

  const result = await provider.play({ query: "Radio Bio Bio Chle", playerId: "eversolo", mode: "radio" });

  assert.equal(result.item.name, "BioBio Chile");
});

test("encuentra una radio con número escrito cuando Whisper lo transcribe como dígito", async () => {
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.command === "music/radios/library_items") return response(request.args.search ? [] : [
      { uri: "library://radio/fm-dos", name: "FM Dos", media_type: "radio" },
      { uri: "library://radio/fm-tiempo", name: "FM Tiempo", media_type: "radio" }
    ]);
    if (request.command === "player_queues/play_media") return response(null);
    if (request.command === "players/all" || request.command === "player_queues/all") return response([]);
    throw new Error(request.command);
  } });

  const result = await provider.play({ query: "FM2", playerId: "eversolo", mode: "radio" });

  assert.equal(result.item.name, "FM Dos");
});

test("pide aclaración cuando varias radios de biblioteca tienen nombres similares", async () => {
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.command === "music/radios/library_items") return response(request.args.search ? [] : [
      { uri: "library://radio/biobio-chile", name: "BioBio Chile", media_type: "radio" },
      { uri: "library://radio/biobio-valparaiso", name: "BioBio Valparaíso", media_type: "radio" },
      { uri: "library://radio/cooperativa", name: "Cooperativa", media_type: "radio" }
    ]);
    throw new Error(`No debía ejecutar ${request.command}`);
  } });

  const result = await provider.play({ query: "Radio BioBio", playerId: "eversolo", mode: "radio" });

  assert.equal(result.clarificationRequired, true);
  assert.deepEqual(result.choices.map((choice) => choice.name), ["BioBio Chile", "BioBio Valparaíso"]);
});

test("lista únicamente las emisoras guardadas en la biblioteca", async () => {
  let request;
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return response([{ uri: "library://radio/42", name: "Radio Bío-Bío", media_type: "radio" }]);
  } });

  const radios = await provider.getLibraryRadios();

  assert.equal(request.command, "music/radios/library_items");
  assert.equal(Object.hasOwn(request.args, "search"), false);
  assert.deepEqual(radios.map((radio) => radio.name), ["Radio Bío-Bío"]);
});

test("lista las playlists disponibles en la biblioteca", async () => {
  let request;
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return response([
      { uri: "library://playlist/1", name: "Favoritas", media_type: "playlist", provider: "spotify--jota" }
    ]);
  } });

  const playlists = await provider.getLibraryPlaylists();

  assert.equal(request.command, "music/playlists/library_items");
  assert.deepEqual(request.args, { limit: 500, offset: 0 });
  assert.deepEqual(playlists.map((playlist) => playlist.name), ["Favoritas"]);
});

test("solicita aclaración cuando una letra hablada coincide con nombres de artista distintos", async () => {
  const commands = [];
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); commands.push(request.command);
    if (request.command === "music/search") return response({ artists: [
      { uri: "tidal://artist/project-j", name: "Proyecto J", media_type: "artist" },
      { uri: "tidal://artist/proyecto-jota", name: "Proyecto Jota", media_type: "artist" }
    ] });
    if (request.command === "music/artists/artist_albums") return response([{ uri: "tidal://album/one" }]);
    if (request.command === "music/albums/album_tracks") return response([{ uri: "tidal://track/one", name: "One" }]);
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
    if (request.command === "music/artists/artist_albums") return response([{ uri: "tidal://album/one" }]);
    if (request.command === "music/albums/album_tracks") return response([{ uri: "tidal://track/one", name: "One" }]);
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
    if (request.command === "music/artists/artist_albums") return response([{ uri: "spotify://album/one" }]);
    if (request.command === "music/albums/album_tracks") return response([{ uri: "spotify://track/one", name: "One" }]);
    if (request.command === "player_queues/play_media" || request.command === "player_queues/shuffle") return response(null);
    throw new Error("estado temporalmente no disponible");
  } });

  const result = await provider.play({ query: "Pink Floyd", playerId: "dmp", mode: "artist", shuffle: true });

  assert.equal(commands.filter((command) => command === "player_queues/play_media").length, 1);
  assert.equal(result.status, "playing");
  assert.equal(result.item.name, "One");
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

test("reproduce la misma radio en el destino cuando MA rechaza transferir la cola", async () => {
  const commands = [];
  let targetPlaying = false;
  const provider = new MusicAssistantProvider({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    commands.push(request);
    if (request.command === "players/all") return response([
      { player_id: "origen", name: "Origen", playback_state: "playing" },
      { player_id: "destino", name: "Destino", playback_state: targetPlaying ? "playing" : "idle" }
    ]);
    if (request.command === "player_queues/all") return response([
      { queue_id: "origen", state: "playing", current_item: { media_item: { uri: "library://radio/fm-dos", name: "FM Dos", media_type: "radio" } } },
      ...(targetPlaying ? [{ queue_id: "destino", state: "playing", current_item: { media_item: { uri: "library://radio/fm-dos", name: "FM Dos", media_type: "radio" } } }] : [])
    ]);
    if (request.command === "player_queues/transfer") return { ok: false, status: 500, json: async () => ({}) };
    if (request.command === "player_queues/play_media") { targetPlaying = true; return response(null); }
    if (request.command === "players/cmd/pause") return response(null);
    throw new Error(request.command);
  } });

  const result = await provider.transfer("origen", "destino", true);

  assert.equal(result.item.name, "FM Dos");
  assert.deepEqual(commands.find((item) => item.command === "player_queues/play_media").args, {
    queue_id: "destino", media: "library://radio/fm-dos", option: "replace"
  });
  assert.deepEqual(commands.find((item) => item.command === "players/cmd/pause").args, { player_id: "origen" });
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

test("prioriza el identificador opaco de portadas de MA 2.9", () => {
  const provider = new MusicAssistantProvider({});
  const proxyId = "a".repeat(64);
  const item = provider.normalizeItem({
    name: "Tema",
    image_url: "https://i.scdn.co/proxy-cover.jpg",
    metadata: {
      images: [{ path: "https://i.scdn.co/cover.jpg", provider: "spotify--123", proxy_id: proxyId }]
    }
  });
  assert.equal(item.artworkUrl, `/v1/artwork?proxyId=${proxyId}`);
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

test("solicita por la ruta canónica las portadas con proxy_id de MA 2.9", async () => {
  let received;
  const proxyId = "b".repeat(64);
  const provider = new MusicAssistantProvider({ token: "valid-token", fetchImpl: async (url, options) => {
    received = { url: url.toString(), authorization: options.headers.Authorization };
    return { ok: true, status: 200, headers: new Headers({ "content-type": "image/jpeg" }) };
  } });
  await provider.getArtwork(null, null, proxyId);
  assert.match(received.url, new RegExp(`/imageproxy/${proxyId}$`));
  assert.equal(received.authorization, "Bearer valid-token");
});

test("rechaza identificadores de portada que no tengan el formato opaco de MA", async () => {
  const provider = new MusicAssistantProvider({});
  await assert.rejects(provider.getArtwork(null, null, "../config"), /identificador de la portada no es válido/);
});
