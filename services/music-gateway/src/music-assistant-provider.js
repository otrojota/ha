const MEDIA_TYPES = ["track", "album", "artist", "playlist", "radio"];

function normalizeText(value) {
  return String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
  constructor({ baseUrl = "http://127.0.0.1:8095", token = "", fetchImpl = fetch, timeoutMs = 15_000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.messageId = 0;
    this.authenticationRequired = !String(token || "").trim();
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

  async command(command, args = {}) {
    const response = await this.fetch(`${this.baseUrl}/api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify({ message_id: String(++this.messageId), command, args }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      this.token = "";
      this.authenticationRequired = true;
      const error = new Error("La autorización de Music Assistant venció o fue revocada");
      error.code = "MUSIC_ASSISTANT_AUTH_REQUIRED";
      throw error;
    }
    if (!response.ok) throw new Error(payload?.details || payload?.message || payload?.error || `Music Assistant respondió HTTP ${response.status}`);
    if (payload?.error_code || payload?.error) throw new Error(payload.details || payload.message || payload.error || "Music Assistant rechazó la solicitud");
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

  async play({ query, playerId, sourceId, mode = "auto", searches = [], shuffle = false, mediaUri }) {
    const mediaTypes = ["artist", "playlist", "album", "radio"].includes(mode) ? [mode] : MEDIA_TYPES;
    if (mode === "album") await this.command("player_queues/shuffle", { queue_id: playerId, shuffle_enabled: false });
    if (mediaUri) {
      await this.command("player_queues/play_media", { queue_id: playerId, media: mediaUri, option: "replace" });
      if (shuffle && mode !== "album") await this.command("player_queues/shuffle", { queue_id: playerId, shuffle_enabled: true });
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
    for (const candidate of [query, ...searches].filter(Boolean)) {
      matches = await this.search(candidate, { mediaTypes, limit: 5, providers: sourceId ? [sourceId] : undefined });
      if (matches.length) break;
    }
    if (!matches.length) throw new Error(`Music Assistant no encontró “${query}” en sus orígenes configurados`);
    const choices = ambiguousChoices(query, matches);
    if (choices.length > 1) return { clarificationRequired: true, query, choices };
    const normalized = normalizeText(query);
    const item = matches.find((match) => normalizeText(itemName(match)) === normalized) || matches[0];
    await this.command("player_queues/play_media", { queue_id: playerId, media: item.uri || item, option: "replace" });
    if (shuffle && mode !== "album") await this.command("player_queues/shuffle", { queue_id: playerId, shuffle_enabled: true });
    return this.playbackAfterAcceptedCommand(playerId, item);
  }

  async playbackAfterAcceptedCommand(playerId, selectedItem) {
    try {
      return await this.getPlayback(playerId);
    } catch {
      // play_media ya fue aceptado. Una lectura de estado lenta no debe convertir
      // una acción con efectos laterales en un error ni provocar que se repita.
      return {
        status: "playing",
        item: this.normalizeItem(selectedItem),
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
  resume(playerId) { return this.playerCommand(playerId, "play"); }
  next(playerId) { return this.playerCommand(playerId, "next"); }
  previous(playerId) { return this.playerCommand(playerId, "previous"); }
  setVolume(playerId, volumePercent) { return this.playerCommand(playerId, "volume_set", { volume_level: Math.max(0, Math.min(100, Math.round(volumePercent))) }); }

  async addToQueue(playerId, query) {
    const matches = await this.search(query, { mediaTypes: ["track"], limit: 5 });
    if (!matches.length) throw new Error(`Music Assistant no encontró “${query}”`);
    await this.command("player_queues/play_media", { queue_id: playerId, media: matches[0].uri || matches[0], option: "add" });
    return this.getQueue(playerId);
  }

  async getQueue(playerId) {
    const queue = await this.resolveQueue(playerId);
    const items = await this.command("player_queues/items", { queue_id: queue.queue_id, limit: 100, offset: 0 });
    return { queueId: queue.queue_id, currentIndex: queue.current_index ?? null, items: items.map((entry) => this.normalizeItem(entry.media_item || entry)) };
  }

  async clearQueue(playerId) {
    const current = await this.getQueue(playerId);
    await this.command("player_queues/clear", { queue_id: playerId });
    return { status: "idle", cleared: current.items.length, remaining: 0 };
  }

  async transfer(sourcePlayerId, targetPlayerId, play = true) {
    await this.command("player_queues/transfer", { source_queue_id: sourcePlayerId, target_queue_id: targetPlayerId, auto_play: play });
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
