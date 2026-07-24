const MEDIA_TYPES = ["track", "album", "artist", "playlist", "radio"];

function normalizeText(value) {
  return String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const SPOKEN_NUMBERS = new Map([
  ["cero", "0"], ["uno", "1"], ["un", "1"], ["una", "1"], ["dos", "2"],
  ["tres", "3"], ["cuatro", "4"], ["cinco", "5"], ["seis", "6"],
  ["siete", "7"], ["ocho", "8"], ["nueve", "9"], ["diez", "10"]
]);

function normalizeRadioName(value) {
  return normalizeText(value)
    .replace(/^(?:la )?(?:radio|emisora|estacion) /, "")
    .split(/\s+/)
    .map((token) => SPOKEN_NUMBERS.get(token) || token)
    .join(" ");
}

function imageUrl(item) {
  const image = item?.metadata?.images?.[0] || item?.image;
  if (!image) return null;
  if (typeof image === "string") return `/v1/artwork?path=${encodeURIComponent(image)}`;
  if (image.path) return `/v1/artwork?path=${encodeURIComponent(image.path)}${image.provider ? `&provider=${encodeURIComponent(image.provider)}` : ""}`;
  return null;
}

function proxiedImageUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.pathname === "/imageproxy" && url.searchParams.get("path")) {
      const provider = url.searchParams.get("provider");
      return `/v1/artwork?path=${encodeURIComponent(url.searchParams.get("path"))}${provider ? `&provider=${encodeURIComponent(provider)}` : ""}`;
    }
  } catch { /* relative path or provider URI */ }
  return `/v1/artwork?path=${encodeURIComponent(raw)}`;
}

function itemName(item) {
  return item?.name || item?.title || item?.media_item?.name || null;
}

function sameMediaItem(current, selected) {
  if (!current || !selected) return false;
  const currentUri = String(current.uri || "").trim();
  const selectedUri = String(selected.uri || "").trim();
  if (currentUri && selectedUri) return currentUri === selectedUri;
  return normalizeText(itemName(current)) === normalizeText(itemName(selected));
}

function mediaReference(item, mediaType, preferredProvider) {
  const mappings = Array.isArray(item?.provider_mappings) ? item.provider_mappings : [];
  const preferredMapping = preferredProvider && mappings.find((mapping) =>
    mapping?.provider_instance === preferredProvider || mapping?.provider_domain === preferredProvider);
  if (preferredMapping?.item_id) return {
    itemId: String(preferredMapping.item_id),
    provider: String(preferredMapping.provider_instance || preferredMapping.provider_domain)
  };
  if (item?.item_id && item?.provider && (!preferredProvider || item.provider !== "library")) {
    return { itemId: String(item.item_id), provider: String(item.provider) };
  }
  const availableMapping = mappings.find((mapping) => mapping?.available !== false && mapping?.item_id);
  if (availableMapping) return {
    itemId: String(availableMapping.item_id),
    provider: String(availableMapping.provider_instance || availableMapping.provider_domain)
  };
  if (item?.item_id && item?.provider) return { itemId: String(item.item_id), provider: String(item.provider) };
  const match = String(item?.uri || "").match(new RegExp(`^([^:]+):\\/\\/${mediaType}\\/(.+)$`));
  return match ? { itemId: match[2], provider: match[1] } : null;
}

function apiErrorMessage(payload, fallback) {
  const error = payload?.error;
  return payload?.details || payload?.message || (typeof error === "string" ? error : error?.details || error?.message) || fallback;
}

function shuffled(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function radioSearchQueries(query) {
  const original = String(query || "").trim();
  const withoutType = original.replace(/^\s*(?:la\s+)?(?:radio|emisora|estaci[oó]n)\s+/i, "").trim();
  return [...new Set([original, withoutType].filter(Boolean))];
}

function radioMatchScore(query, name) {
  const normalizedQuery = normalizeRadioName(query);
  const normalizedName = normalizeRadioName(name);
  if (!normalizedQuery || !normalizedName) return 0;
  if (normalizedQuery === normalizedName) return 1;
  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const compactName = normalizedName.replace(/\s+/g, "");
  if (compactQuery === compactName) return 1;
  if (compactName.includes(compactQuery) || compactQuery.includes(compactName)) return 0.86;
  return nameSimilarity(query, name);
}

function similarLibraryRadios(query, radios) {
  return radios.map((item) => ({ item, score: radioMatchScore(query, itemName(item)) }))
    .filter(({ score }) => score >= 0.6)
    .sort((left, right) => right.score - left.score)
    .slice(0, 10)
    .map(({ item }) => item);
}

function ambiguousRadioChoices(query, matches) {
  const ranked = [...new Map(matches.filter((item) => itemName(item) && item.uri)
    .map((item) => [item.uri, item])).values()]
    .map((item) => ({ item, score: radioMatchScore(query, itemName(item)) }))
    .sort((left, right) => right.score - left.score);
  if (ranked.length < 2 || ranked[0].score === 1 || ranked[1].score < 0.68 || ranked[0].score - ranked[1].score > 0.08) return [];
  return ranked.filter(({ score }) => score >= ranked[0].score - 0.08).slice(0, 4).map(({ item }) => ({
    name: itemName(item), uri: item.uri, mediaType: "radio"
  }));
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function comparableName(value) {
  return normalizeText(value).replace(/\bj\b/g, "jota").replace(/\by\b/g, "i").replace(/\s+/g, "");
}

function nameSimilarity(left, right) {
  const a = comparableName(left); const b = comparableName(right);
  return a && b ? 1 - editDistance(a, b) / Math.max(a.length, b.length) : 0;
}

function ambiguousChoices(query, matches) {
  const unique = [...new Map(matches.filter((item) => itemName(item) && item.uri)
    .map((item) => [`${item.media_type || "media"}:${normalizeText(itemName(item))}`, item])).values()];
  if (unique.length < 2) return [];
  const allRanked = unique.map((item) => ({ item, score: nameSimilarity(query, itemName(item)) }))
    .sort((left, right) => right.score - left.score);
  const primaryType = allRanked[0].item.media_type || null;
  const ranked = allRanked.filter(({ item }) => (item.media_type || null) === primaryType);
  if (ranked.length < 2) return [];
  const exact = ranked.find(({ item }) => normalizeText(itemName(item)) === normalizeText(query));
  const spokenLetterCollision = exact && /\b[a-z]\b/.test(normalizeText(query))
    && ranked.some(({ item }) => item !== exact.item && comparableName(itemName(item)) === comparableName(query));
  if (exact && !spokenLetterCollision) return [];
  if (!spokenLetterCollision && (ranked[0].score < 0.72 || ranked[1].score < 0.68 || ranked[0].score - ranked[1].score > 0.08)) return [];
  return ranked.filter(({ score }) => score >= Math.max(0.68, ranked[0].score - 0.08)).slice(0, 4).map(({ item }) => ({
    name: itemName(item), uri: item.uri, mediaType: item.media_type || null
  }));
}

export class MusicAssistantProvider {
  constructor({ baseUrl = "http://127.0.0.1:8095", token = "", fetchImpl = fetch, timeoutMs = 15_000,
    randomImpl = Math.random, artistQueueSize = 50, artistAlbumConcurrency = 4,
    artistAlbumTimeoutMs = 8_000, log = () => {} }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.messageId = 0;
    this.authenticationRequired = !String(token || "").trim();
    this.random = randomImpl;
    this.artistQueueSize = artistQueueSize;
    this.artistAlbumConcurrency = Math.max(1, artistAlbumConcurrency);
    this.artistAlbumTimeoutMs = Math.max(1_000, artistAlbumTimeoutMs);
    this.previousArtistQueues = new Map();
    this.queueGenerations = new Map();
    this.queueMutationChains = new Map();
    this.artistQueueFillPromises = new Map();
    this.log = log;
  }

  setToken(token) {
    this.token = String(token || "").trim();
    this.authenticationRequired = !this.token;
  }

  async login(username, password) {
    const response = await this.fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "builtin", credentials: { username, password }, device_name: "HA Music Gateway bootstrap" }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const result = await response.json().catch(() => ({}));
    const sessionToken = result.token || result.access_token;
    if (!response.ok || result.success === false || !sessionToken) {
      throw new Error(result.error || result.message || `Music Assistant rechazó el inicio de sesión (HTTP ${response.status})`);
    }
    this.setToken(sessionToken);
    try {
      const token = await this.command("auth/token/create", { name: "HA Music Gateway" });
      this.setToken(token);
      return token;
    } catch (error) {
      this.setToken("");
      throw error;
    }
  }

  async command(command, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    const response = await this.fetch(`${this.baseUrl}/api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify({ message_id: String(++this.messageId), command, args }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      this.token = "";
      this.authenticationRequired = true;
      const error = new Error("La autorización de Music Assistant venció o fue revocada");
      error.code = "MUSIC_ASSISTANT_AUTH_REQUIRED";
      throw error;
    }
    if (!response.ok) throw new Error(apiErrorMessage(payload, `Music Assistant respondió HTTP ${response.status}`));
    if (payload?.error_code || payload?.error) throw new Error(apiErrorMessage(payload, "Music Assistant rechazó la solicitud"));
    return payload && Object.hasOwn(payload, "result") ? payload.result : payload;
  }

  async health() {
    const players = await this.command("players/all");
    return { status: "ok", provider: "music-assistant", url: this.baseUrl, players: players.length };
  }

  async getArtwork(path, provider) {
    const url = new URL(`${this.baseUrl}/imageproxy`);
    url.searchParams.set("path", path);
    if (provider) url.searchParams.set("provider", provider);
    const response = await this.fetch(url, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (response.status === 401) {
      this.token = "";
      this.authenticationRequired = true;
      const error = new Error("La autorización de Music Assistant venció o fue revocada");
      error.code = "MUSIC_ASSISTANT_AUTH_REQUIRED";
      throw error;
    }
    if (!response.ok) throw new Error(`Music Assistant no pudo obtener la portada (HTTP ${response.status})`);
    return response;
  }

  async getSources() {
    const providers = await this.command("providers");
    return providers.filter((provider) => provider.type === "music").map((provider) => ({
      id: provider.instance_id,
      domain: provider.domain,
      name: provider.name || provider.instance_name || provider.domain,
      available: provider.available !== false,
      streaming: Boolean(provider.is_streaming_provider)
    }));
  }

  async getPlayers() {
    const players = await this.command("players/all");
    return players.map((player) => ({
      id: player.player_id,
      name: player.name,
      provider: player.provider,
      model: player.device_info?.model || "",
      manufacturer: player.device_info?.manufacturer || "",
      available: player.available !== false,
      enabled: player.enabled !== false,
      powered: player.powered !== false,
      volumePercent: player.volume_level ?? null,
      active: false,
      routes: (player.output_protocols || []).map((route) => ({ id: route.output_protocol_id, name: route.name, available: route.available !== false }))
    }));
  }

  async getQueues() { return this.command("player_queues/all"); }

  async resolveQueue(playerId) {
    const queues = await this.getQueues();
    return queues.find((queue) => queue.queue_id === playerId)
      || queues.find((queue) => queue.active && queue.queue_id === playerId)
      || { queue_id: playerId };
  }

  async search(query, { mediaTypes = MEDIA_TYPES, limit = 5, providers } = {}) {
    const result = await this.command("music/search", { search_query: query, media_types: mediaTypes, limit, providers });
    return mediaTypes.flatMap((type) => result[`${type}s`] || result[type] || []);
  }

  selectTrackQueue(tracks, historyKey, shuffle) {
    const unique = [...new Map((tracks || []).filter((track) => track?.uri)
      .map((track) => [track.uri, track])).values()];
    if (!unique.length) return [];
    if (!shuffle) return unique.slice(0, this.artistQueueSize).map((track) => track.uri);
    const previous = this.previousArtistQueues.get(historyKey) || [];
    const previousSet = new Set(previous);
    const candidates = shuffled(unique, this.random);
    const ordered = [
      ...candidates.filter((track) => !previousSet.has(track.uri)),
      ...candidates.filter((track) => previousSet.has(track.uri))
    ];
    const selected = ordered.slice(0, this.artistQueueSize);
    if (selected.length > 1 && selected[0].uri === previous[0]) {
      [selected[0], selected[1]] = [selected[1], selected[0]];
    }
    const uris = selected.map((track) => track.uri);
    this.previousArtistQueues.set(historyKey, uris);
    return uris;
  }

  async getArtistTracks(artist) {
    const reference = mediaReference(artist, "artist");
    if (!reference) throw new Error("Music Assistant no informó cómo consultar las canciones del artista");
    return this.command("music/artists/artist_tracks", {
      item_id: reference.itemId,
      provider_instance_id_or_domain: reference.provider
    });
  }

  async buildPopularArtistQueue(artist, shuffle) {
    const reference = mediaReference(artist, "artist");
    const historyKey = artist.uri || `${reference?.provider}:${reference?.itemId}`;
    const uris = this.selectTrackQueue(await this.getArtistTracks(artist), `popular:${historyKey}`, shuffle);
    if (!uris.length) throw new Error(`Music Assistant no encontró canciones populares de “${itemName(artist)}”`);
    return uris;
  }

  beginQueueGeneration(playerId) {
    const generation = (this.queueGenerations.get(playerId) || 0) + 1;
    this.queueGenerations.set(playerId, generation);
    return generation;
  }

  isCurrentQueueGeneration(playerId, generation) {
    return this.queueGenerations.get(playerId) === generation;
  }

  async mutateQueue(playerId, generation, operation) {
    const previous = this.queueMutationChains.get(playerId) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      if (!this.isCurrentQueueGeneration(playerId, generation)) return false;
      await operation();
      return true;
    });
    this.queueMutationChains.set(playerId, current);
    try {
      return await current;
    } finally {
      if (this.queueMutationChains.get(playerId) === current) this.queueMutationChains.delete(playerId);
    }
  }

  async albumTracks(album, sourceId) {
    const reference = mediaReference(album, "album", sourceId);
    if (!reference) return [];
    return this.command("music/albums/album_tracks", {
      item_id: reference.itemId,
      provider_instance_id_or_domain: reference.provider
    }, { timeoutMs: Math.min(this.timeoutMs, this.artistAlbumTimeoutMs) });
  }

  async playArtistProgressively(artist, playerId, sourceId, generation) {
    const reference = mediaReference(artist, "artist", sourceId);
    if (!reference) throw new Error("Music Assistant no informó cómo consultar los álbumes del artista");
    const albums = shuffled(await this.command("music/artists/artist_albums", {
      item_id: reference.itemId,
      provider_instance_id_or_domain: reference.provider
    }), this.random);
    const failures = [];
    let initialAlbum;
    let initialTracks = [];
    while (albums.length && !initialTracks.length) {
      initialAlbum = albums.shift();
      try {
        initialTracks = (await this.albumTracks(initialAlbum, sourceId)).filter((track) => track?.uri);
      } catch (error) {
        failures.push(error);
        this.log("warn", "Se omitió un álbum al buscar la primera canción del artista", {
          artist: itemName(artist), album: itemName(initialAlbum), error: error.message
        });
      }
    }
    if (!initialTracks.length) {
      let fallback = [];
      try {
        fallback = (await this.getArtistTracks(artist)).filter((track) => track?.uri);
      } catch (error) {
        failures.push(error);
      }
      if (!fallback.length) throw new Error(failures[0]?.message
        ? `Music Assistant no pudo leer los álbumes de “${itemName(artist)}”: ${failures[0].message}`
        : `Music Assistant no encontró pistas de “${itemName(artist)}”`);
      initialTracks = fallback;
    }
    const historyKey = artist.uri || `${reference.provider}:${reference.itemId}`;
    const previousFirst = this.previousArtistQueues.get(`progressive:${historyKey}`)?.[0];
    const randomizedInitialTracks = shuffled(initialTracks, this.random);
    const firstTrack = randomizedInitialTracks.find((track) => track.uri !== previousFirst) || randomizedInitialTracks[0];
    this.previousArtistQueues.set(`progressive:${historyKey}`, [firstTrack.uri]);
    const replaced = await this.mutateQueue(playerId, generation, () => this.command("player_queues/play_media", {
      queue_id: playerId, media: firstTrack.uri, option: "replace"
    }));
    if (!replaced) throw new Error("La solicitud musical fue reemplazada por una más reciente");

    const fill = this.fillArtistQueueInBackground({
      artist, playerId, sourceId, generation, albums,
      firstTrack, initialTracks: initialTracks.filter((track) => track.uri !== firstTrack.uri)
    }).catch((error) => this.log("warn", "No se pudo completar la cola progresiva del artista", {
      artist: itemName(artist), playerId, error: error.message
    })).finally(() => {
      if (this.artistQueueFillPromises.get(playerId) === fill) this.artistQueueFillPromises.delete(playerId);
    });
    this.artistQueueFillPromises.set(playerId, fill);
    return { firstTrack, initialAlbum };
  }

  async fillArtistQueueInBackground({ artist, playerId, sourceId, generation, albums, firstTrack, initialTracks }) {
    const seen = new Set([firstTrack.uri]);
    const extras = shuffled(initialTracks, this.random).filter((track) => track?.uri && !seen.has(track.uri));
    const append = async (track) => {
      if (!track?.uri || seen.has(track.uri) || seen.size >= this.artistQueueSize) return;
      seen.add(track.uri);
      await this.mutateQueue(playerId, generation, () => this.command("player_queues/play_media", {
        queue_id: playerId, media: track.uri, option: "add"
      }));
    };
    const pending = [...albums];
    const workers = Array.from({ length: Math.min(this.artistAlbumConcurrency, pending.length) }, async () => {
      while (pending.length && this.isCurrentQueueGeneration(playerId, generation) && seen.size < this.artistQueueSize) {
        const album = pending.shift();
        try {
          const tracks = shuffled((await this.albumTracks(album, sourceId)).filter((track) => track?.uri), this.random);
          if (tracks[0]) await append(tracks[0]);
          extras.push(...tracks.slice(1));
        } catch (error) {
          this.log("warn", "Se omitió un álbum al completar la cola progresiva", {
            artist: itemName(artist), album: itemName(album), error: error.message
          });
        }
      }
    });
    await Promise.all(workers);
    for (const track of shuffled(extras, this.random)) {
      if (!this.isCurrentQueueGeneration(playerId, generation) || seen.size >= this.artistQueueSize) break;
      await append(track);
    }
  }

  async buildArtistDiscographyQueue(artist, sourceId, shuffle) {
    const reference = mediaReference(artist, "artist", sourceId);
    if (!reference) throw new Error("Music Assistant no informó cómo consultar los álbumes del artista");
    const albums = await this.command("music/artists/artist_albums", {
      item_id: reference.itemId,
      provider_instance_id_or_domain: reference.provider
    });
    const tracks = [];
    const failures = [];
    const pending = [...(albums || [])];
    const worker = async () => {
      while (pending.length) {
        const album = pending.shift();
        const albumReference = mediaReference(album, "album", sourceId);
        if (!albumReference) continue;
        try {
          const albumTracks = await this.command("music/albums/album_tracks", {
            item_id: albumReference.itemId,
            provider_instance_id_or_domain: albumReference.provider
          }, { timeoutMs: Math.min(this.timeoutMs, this.artistAlbumTimeoutMs) });
          tracks.push(...(albumTracks || []));
        } catch (error) {
          failures.push(error);
          this.log("warn", "Se omitió un álbum no disponible al construir la discografía", {
            artist: itemName(artist), album: itemName(album), provider: albumReference.provider, error: error.message
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.artistAlbumConcurrency, pending.length) }, worker));
    // Ediciones deluxe, remasters y recopilatorios suelen repetir la misma
    // grabación. La primera aparición conserva el álbum preferido por MA.
    const deduplicated = [...new Map(tracks.filter((track) => track?.uri && itemName(track))
      .map((track) => [normalizeText(itemName(track)), track])).values()];
    const historyKey = artist.uri || `${reference.provider}:${reference.itemId}`;
    const uris = this.selectTrackQueue(deduplicated, `discography:${historyKey}`, shuffle);
    if (!uris.length) {
      const detail = failures[0]?.message;
      throw new Error(detail
        ? `Music Assistant no pudo leer los álbumes de “${itemName(artist)}”: ${detail}`
        : `Music Assistant no encontró pistas en los álbumes de “${itemName(artist)}”`);
    }
    return uris;
  }

  async buildSimilarTrackQueue(track, sourceId, shuffle) {
    const reference = mediaReference(track, "track");
    if (!reference) throw new Error("Music Assistant no informó cómo consultar canciones parecidas");
    const similar = await this.command("music/tracks/similar_tracks", {
      item_id: reference.itemId,
      provider_instance_id_or_domain: reference.provider,
      limit: this.artistQueueSize,
      allow_lookup: true,
      ...(sourceId ? { preferred_provider_instances: [sourceId] } : {})
    });
    const historyKey = track.uri || `${reference.provider}:${reference.itemId}`;
    const uris = this.selectTrackQueue(similar, `similar:${historyKey}`, shuffle);
    if (!uris.length) throw new Error(`Music Assistant no encontró canciones parecidas a “${itemName(track)}” en los proveedores disponibles`);
    return uris;
  }

  async searchLibraryRadios(query, { limit = 25, provider } = {}) {
    return this.command("music/radios/library_items", {
      ...(String(query || "").trim() ? { search: query } : {}), limit, offset: 0, ...(provider ? { provider } : {})
    });
  }

  async getLibraryRadios({ limit = 500 } = {}) {
    return (await this.searchLibraryRadios("", { limit })).map((radio) => this.normalizeItem(radio));
  }

  async play({ query, playerId, sourceId, mode = "auto", searches = [], shuffle = false, mediaUri }) {
    const generation = this.beginQueueGeneration(playerId);
    const mediaTypes = mode === "popular" ? ["artist"] : mode === "similar" ? ["track"]
      : ["artist", "playlist", "album", "radio"].includes(mode) ? [mode] : MEDIA_TYPES;
    if (mode === "album") await this.command("player_queues/shuffle", { queue_id: playerId, shuffle_enabled: false });
    if (mediaUri) {
      if (mode === "artist") {
        const { firstTrack } = await this.playArtistProgressively({ uri: mediaUri, name: query }, playerId, sourceId, generation);
        return { status: "playing", item: this.normalizeItem(firstTrack), progressMs: 0,
          device: { id: playerId, name: null, volumePercent: null }, queueId: playerId, statePending: true };
      }
      if (["artist", "popular", "similar"].includes(mode)) {
        const selected = { uri: mediaUri, name: query };
        const queue = mode === "artist" ? await this.buildArtistDiscographyQueue(selected, sourceId, shuffle)
          : mode === "popular" ? await this.buildPopularArtistQueue(selected, shuffle)
            : await this.buildSimilarTrackQueue(selected, sourceId, shuffle);
        await this.command("player_queues/play_media", { queue_id: playerId, media: queue, option: "replace" });
      } else {
        await this.command("player_queues/play_media", { queue_id: playerId, media: mediaUri, option: "replace" });
        if (shuffle && mode !== "album") await this.command("player_queues/shuffle", { queue_id: playerId, shuffle_enabled: true });
      }
      return this.playbackAfterAcceptedCommand(playerId, { uri: mediaUri, name: query, media_type: mode });
    }
    if (mode === "custom" && searches.length) {
      const selected = [];
      for (const candidate of searches) {
        const matches = await this.search(candidate, { mediaTypes: ["track"], limit: 1, providers: sourceId ? [sourceId] : undefined });
        if (matches[0]) selected.push(matches[0].uri || matches[0]);
      }
      if (!selected.length) throw new Error("Music Assistant no encontró elementos para la selección solicitada");
      await this.command("player_queues/play_media", { queue_id: playerId, media: selected, option: "replace" });
      if (shuffle) await this.command("player_queues/shuffle", { queue_id: playerId, shuffle_enabled: true });
      return this.playbackAfterAcceptedCommand(playerId, null);
    }
    let matches = [];
    if (mode === "radio") {
      const radioQueries = radioSearchQueries(query);
      for (const radioQuery of radioQueries) {
        matches = await this.searchLibraryRadios(radioQuery, { provider: sourceId });
        if (matches.length) break;
      }
      const comparisonQuery = radioQueries.at(-1);
      const exact = matches.some((match) => radioMatchScore(comparisonQuery, itemName(match)) === 1);
      if (!exact) {
        const library = await this.searchLibraryRadios("", { limit: 500, provider: sourceId });
        matches = similarLibraryRadios(comparisonQuery, library);
      }
    }
    for (const candidate of [query, ...searches].filter(Boolean)) {
      if (mode === "radio") break;
      matches = await this.search(candidate, { mediaTypes, limit: 5, providers: sourceId ? [sourceId] : undefined });
      if (matches.length) break;
    }
    if (!matches.length) throw new Error(mode === "radio"
      ? `Music Assistant no encontró la radio “${query}” en la biblioteca`
      : `Music Assistant no encontró “${query}” en sus orígenes configurados`);
    const radioQuery = mode === "radio" ? radioSearchQueries(query).at(-1) : query;
    const choices = mode === "radio" ? ambiguousRadioChoices(radioQuery, matches) : ambiguousChoices(query, matches);
    if (choices.length > 1) return { clarificationRequired: true, query, choices };
    const normalized = mode === "radio" ? normalizeRadioName(radioQuery) : normalizeText(radioQuery);
    const item = matches.find((match) => (mode === "radio" ? normalizeRadioName(itemName(match)) : normalizeText(itemName(match))) === normalized) || matches[0];
    if (mode === "artist") {
      const { firstTrack } = await this.playArtistProgressively(item, playerId, sourceId, generation);
      return { status: "playing", item: this.normalizeItem(firstTrack), progressMs: 0,
        device: { id: playerId, name: null, volumePercent: null }, queueId: playerId, statePending: true };
    }
    if (["artist", "popular", "similar"].includes(mode)) {
      const queue = mode === "artist" ? await this.buildArtistDiscographyQueue(item, sourceId, shuffle)
        : mode === "popular" ? await this.buildPopularArtistQueue(item, shuffle)
          : await this.buildSimilarTrackQueue(item, sourceId, shuffle);
      await this.command("player_queues/play_media", { queue_id: playerId, media: queue, option: "replace" });
    } else {
      await this.command("player_queues/play_media", { queue_id: playerId, media: item.uri || item, option: "replace" });
      if (shuffle && mode !== "album") await this.command("player_queues/shuffle", { queue_id: playerId, shuffle_enabled: true });
    }
    return this.playbackAfterAcceptedCommand(playerId, item);
  }

  async playbackAfterAcceptedCommand(playerId, selectedItem) {
    const normalizedSelected = this.normalizeItem(selectedItem);
    try {
      let playback = await this.getPlayback(playerId);
      if (!selectedItem || normalizedSelected?.mediaType !== "radio" || sameMediaItem(playback.item, normalizedSelected)) return playback;
      // Music Assistant acepta play_media antes de actualizar la cola. Una
      // lectura inmediata puede seguir mostrando la emisora anterior.
      for (const waitMs of [100, 200, 400]) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        playback = await this.getPlayback(playerId);
        if (sameMediaItem(playback.item, normalizedSelected)) return playback;
      }
      return {
        ...playback,
        status: "playing",
        item: normalizedSelected,
        previousItem: playback.item || null,
        statePending: true
      };
    } catch {
      // play_media ya fue aceptado. Una lectura de estado lenta no debe convertir
      // una acción con efectos laterales en un error ni provocar que se repita.
      return {
        status: "playing",
        item: normalizedSelected,
        progressMs: 0,
        device: { id: playerId, name: null, volumePercent: null },
        queueId: playerId,
        statePending: true
      };
    }
  }

  async playerCommand(playerId, command, args = {}) {
    await this.command(`players/cmd/${command}`, { player_id: playerId, ...args });
    return this.getPlayback(playerId);
  }

  pause(playerId) { return this.playerCommand(playerId, "pause"); }
  async resume(playerId) {
    const queue = await this.resolveQueue(playerId);
    if (queue.current_item) return this.playerCommand(playerId, "play");
    let recent = await this.command("music/recently_played_items", {
      limit: 10, media_types: ["track", "album", "playlist", "radio"], queue_id: playerId
    });
    if (!recent?.length) recent = await this.command("music/recently_played_items", {
      limit: 10, media_types: ["track", "album", "playlist", "radio"]
    });
    const item = recent?.find((candidate) => candidate?.uri);
    if (!item) throw new Error("Music Assistant no tiene una reproducción pausada ni elementos recientes para continuar");
    await this.command("player_queues/play_media", { queue_id: playerId, media: item.uri, option: "replace" });
    return this.playbackAfterAcceptedCommand(playerId, item);
  }
  next(playerId) { return this.moveQueue(playerId, "next"); }
  previous(playerId) { return this.moveQueue(playerId, "previous"); }
  setVolume(playerId, volumePercent) { return this.playerCommand(playerId, "volume_set", { volume_level: Math.max(0, Math.min(100, Math.round(volumePercent))) }); }

  async moveQueue(playerId, direction) {
    const beforeQueue = await this.resolveQueue(playerId);
    const beforeIndex = beforeQueue.current_index;
    const beforeItem = this.normalizeItem(beforeQueue.current_item?.media_item || beforeQueue.current_item);
    await this.command(`player_queues/${direction}`, { queue_id: beforeQueue.queue_id });
    for (const waitMs of [0, 100, 250, 500, 1000]) {
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const queue = await this.resolveQueue(playerId);
      const item = this.normalizeItem(queue.current_item?.media_item || queue.current_item);
      if ((Number.isInteger(queue.current_index) && queue.current_index !== beforeIndex) || !sameMediaItem(item, beforeItem)) {
        const playback = await this.getPlayback(playerId);
        return { ...playback, previousItem: beforeItem, queueIndex: queue.current_index };
      }
    }
    throw new Error(`Music Assistant no cambió a la canción ${direction === "next" ? "siguiente" : "anterior"}`);
  }

  async addToQueue(playerId, query) {
    const matches = await this.search(query, { mediaTypes: ["track"], limit: 5 });
    if (!matches.length) throw new Error(`Music Assistant no encontró “${query}”`);
    await this.command("player_queues/play_media", { queue_id: playerId, media: matches[0].uri || matches[0], option: "add" });
    return this.getQueue(playerId);
  }

  async getQueue(playerId) {
    const queue = await this.resolveQueue(playerId);
    const rawItems = await this.command("player_queues/items", { queue_id: queue.queue_id, limit: 100, offset: 0 });
    const items = rawItems.map((entry) => this.normalizeItem(entry.media_item || entry));
    const currentIndex = Number.isInteger(queue.current_index) ? queue.current_index : null;
    const queueCurrent = this.normalizeItem(queue.current_item?.media_item || queue.current_item);
    const current = currentIndex !== null ? (items[currentIndex] || queueCurrent) : queueCurrent;
    const upcoming = currentIndex !== null ? items.slice(currentIndex + 1) : items;
    return { queueId: queue.queue_id, currentIndex, current, next: upcoming[0] || null, upcoming, items };
  }

  async clearQueue(playerId) {
    const current = await this.getQueue(playerId);
    await this.command("player_queues/clear", { queue_id: playerId });
    return { status: "idle", cleared: current.items.length, remaining: 0 };
  }

  async transfer(sourcePlayerId, targetPlayerId, play = true) {
    const sourcePlayback = await this.getPlayback(sourcePlayerId);
    try {
      await this.command("player_queues/transfer", { source_queue_id: sourcePlayerId, target_queue_id: targetPlayerId, auto_play: play });
    } catch (error) {
      if (error.code === "MUSIC_ASSISTANT_AUTH_REQUIRED" || !sourcePlayback.item?.uri) throw error;
      await this.command("player_queues/play_media", {
        queue_id: targetPlayerId,
        media: sourcePlayback.item.uri,
        option: "replace"
      });
      if (!play) await this.command("players/cmd/pause", { player_id: targetPlayerId });
      await this.command("players/cmd/pause", { player_id: sourcePlayerId });
    }
    return this.getPlayback(targetPlayerId);
  }

  normalizeItem(raw) {
    if (!raw) return null;
    const artists = raw.artists?.map((artist) => artist.name) || (raw.artist ? [raw.artist] : []);
    const artworkUrl = proxiedImageUrl(raw.image_url) || imageUrl(raw);
    const mappings = raw.provider_mappings || [];
    const externalMapping = mappings.find((mapping) => mapping.provider_domain !== "library" && mapping.provider_instance !== "library");
    const storedInLibrary = raw.provider === "library" || String(raw.uri || "").startsWith("library://");
    return {
      uri: raw.uri || null,
      name: itemName(raw),
      mediaType: raw.media_type || null,
      artists,
      album: raw.album?.name || raw.album || null,
      durationMs: raw.duration ? Math.round(raw.duration * 1000) : null,
      artworkUrl,
      artwork: { url: artworkUrl },
      provider: externalMapping?.provider_instance || externalMapping?.provider_domain || raw.provider || null,
      library: storedInLibrary
    };
  }

  async getPlayback(playerId) {
    const [players, queues] = await Promise.all([this.command("players/all"), this.getQueues()]);
    const player = players.find((entry) => entry.player_id === playerId) || players.find((entry) => entry.active_source === playerId);
    const queue = queues.find((entry) => entry.queue_id === (player?.active_source || playerId)) || queues.find((entry) => entry.queue_id === playerId);
    const rawItem = queue?.current_item?.media_item || queue?.current_item || player?.current_media;
    return {
      status: queue?.state || player?.playback_state || "idle",
      item: this.normalizeItem(rawItem),
      progressMs: Math.round((queue?.elapsed_time || player?.elapsed_time || 0) * 1000),
      device: player ? { id: player.player_id, name: player.name, volumePercent: player.volume_level ?? null } : null,
      queueId: queue?.queue_id || playerId
    };
  }
}
