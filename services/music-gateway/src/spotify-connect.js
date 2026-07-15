import { createHash, randomBytes } from "node:crypto";

const scopes = "user-read-playback-state user-modify-playback-state";

function base64Url(value) {
  return value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function normalizeDevice(device) {
  if (!device.id) return null;
  return {
    id: `spotify:${device.id}`,
    providerDeviceId: device.id,
    name: device.name || "Dispositivo Spotify",
    model: device.type || "Spotify Connect",
    source: "spotify-connect",
    available: true,
    restricted: Boolean(device.is_restricted),
    active: Boolean(device.is_active),
    volumePercent: device.volume_percent,
    routes: [{
      id: `spotify:${device.id}:connect`,
      provider: "spotify",
      protocol: "spotify-connect",
      label: "Spotify Connect",
      available: !device.is_restricted
    }]
  };
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function spotifyError(result, status) {
  const message = typeof result === "string" ? result : (result?.error_description || result?.error?.message || result?.error);
  if (/user is not registered for this application/i.test(String(message))) {
    return "Esta cuenta no está autorizada en la aplicación Spotify. Agrégala en Spotify for Developers → Settings → Users Management y vuelve a conectar la cuenta.";
  }
  return message || `Spotify respondió HTTP ${status}`;
}

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

export class SpotifyConnect {
  constructor({ store, fetchImpl = fetch, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) }) {
    this.store = store;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.pending = new Map();
    this.artworkCache = new Map();
  }

  publicConfig() {
    const config = this.store.getSpotifyIntegration();
    return { clientId: config.clientId, redirectUri: config.redirectUri, connected: Boolean(config.refreshToken || config.accessToken) };
  }

  async authorizationUrl() {
    const config = this.store.getSpotifyIntegration();
    if (!config.clientId) throw new Error("Configura primero el Client ID de Spotify");
    const state = base64Url(randomBytes(24));
    const verifier = base64Url(randomBytes(64));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    this.pending.set(state, { verifier, createdAt: Date.now() });
    for (const [key, value] of this.pending) if (Date.now() - value.createdAt > 10 * 60_000) this.pending.delete(key);
    const url = new URL("https://accounts.spotify.com/authorize");
    url.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: config.redirectUri,
      scope: scopes,
      code_challenge_method: "S256",
      code_challenge: challenge,
      state
    });
    return url.toString();
  }

  async completeAuthorization({ code, state, error }) {
    if (error) throw new Error(`Spotify rechazó la autorización: ${error}`);
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || !code) throw new Error("La autorización expiró o su estado no es válido");
    const config = this.store.getSpotifyIntegration();
    const response = await this.fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: pending.verifier
      })
    });
    const result = await responseBody(response);
    if (!response.ok) throw new Error(spotifyError(result, response.status));
    await this.store.updateSpotifyIntegration({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + result.expires_in * 1000,
      scope: result.scope || scopes
    });
  }

  async accessToken() {
    let config = this.store.getSpotifyIntegration();
    if (config.accessToken && config.expiresAt > Date.now() + 30_000) return config.accessToken;
    if (!config.refreshToken) throw new Error("Conecta primero una cuenta de Spotify");
    const response = await this.fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.clientId, grant_type: "refresh_token", refresh_token: config.refreshToken })
    });
    const result = await responseBody(response);
    if (!response.ok) throw new Error(spotifyError(result, response.status));
    config = await this.store.updateSpotifyIntegration({
      accessToken: result.access_token,
      refreshToken: result.refresh_token || config.refreshToken,
      expiresAt: Date.now() + result.expires_in * 1000,
      scope: result.scope || config.scope
    });
    return config.accessToken;
  }

  async discover() {
    const token = await this.accessToken();
    const response = await this.fetch("https://api.spotify.com/v1/me/player/devices", { headers: { Authorization: `Bearer ${token}` } });
    const result = await responseBody(response);
    if (!response.ok) throw new Error(spotifyError(result, response.status));
    const devices = (result.devices || []).map(normalizeDevice).filter(Boolean);
    const playbackResponse = await this.fetch("https://api.spotify.com/v1/me/player", { headers: { Authorization: `Bearer ${token}` } });
    if (playbackResponse.ok && playbackResponse.status !== 204) {
      const playback = await responseBody(playbackResponse);
      const activeDevice = normalizeDevice(playback?.device);
      if (activeDevice && !devices.some((device) => device.id === activeDevice.id)) devices.push(activeDevice);
    }
    return devices;
  }

  async api(path, options = {}) {
    const token = await this.accessToken();
    const response = await this.fetch(`https://api.spotify.com/v1${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
    });
    const result = await responseBody(response);
    if (!response.ok) throw new Error(spotifyError(result, response.status));
    return result;
  }

  async play(query, providerDeviceId, { mode = "auto", searches = [], shuffle = true } = {}) {
    if (!providerDeviceId) throw new Error("El destino Spotify no tiene un identificador controlable");
    let item;
    let body;
    if (mode === "custom") {
      const terms = [...new Set((searches.length ? searches : [query]).map((value) => String(value).trim()).filter(Boolean))].slice(0, 12);
      const results = await Promise.all(terms.map((term) => this.api(`/search?${new URLSearchParams({ q: term, type: "track", limit: "3" })}`)));
      const tracks = results.flatMap((result) => result.tracks?.items || []).filter(Boolean);
      const unique = [...new Map(tracks.map((track) => [track.uri, track])).values()];
      if (!unique.length) throw new Error(`Spotify no encontró canciones para “${query}”`);
      body = { uris: unique.map((track) => track.uri) };
      item = { name: query, type: "temporary-queue", uri: null, count: unique.length };
    } else {
      const type = mode === "artist" ? "artist" : (["similar", "playlist"].includes(mode) ? "playlist" : "track,artist,album,playlist");
      const search = await this.api(`/search?${new URLSearchParams({ q: query, type, limit: "5" })}`);
      const priority = mode === "artist" ? [search.artists]
        : ["similar", "playlist"].includes(mode) ? [search.playlists]
          : [search.tracks, search.albums, search.artists, search.playlists];
      const items = priority.filter(Boolean).flatMap((group) => group.items || []).filter(Boolean);
      if (!items.length) throw new Error(`Spotify no encontró “${query}”`);
      item = items.find((candidate) => normalized(candidate.name) === normalized(query)) || items[0];
      body = item.type === "track" ? { uris: [item.uri] } : { context_uri: item.uri };
    }
    await this.api(`/me/player/play?${new URLSearchParams({ device_id: providerDeviceId })}`, { method: "PUT", body: JSON.stringify(body) });
    if (mode !== "playlist") {
      try {
        await this.api(`/me/player/shuffle?${new URLSearchParams({ state: String(Boolean(shuffle)), device_id: providerDeviceId })}`, { method: "PUT" });
      } catch { /* Algunos dispositivos reproducen el contexto pero no aceptan shuffle remoto. */ }
    }
    return { status: "playing", item: { name: item.name, type: item.type, uri: item.uri, count: item.count } };
  }

  async pause(providerDeviceId) {
    try {
      await this.api(`/me/player/pause?${new URLSearchParams({ device_id: providerDeviceId })}`, { method: "PUT" });
      return { status: "paused" };
    } catch (error) {
      // Algunos receptores Connect aplican la pausa pero Spotify responde
      // "Restriction violated". El estado observado es la confirmación final.
      const playback = await this.getPlayback().catch(() => null);
      if (playback?.status === "paused" && (!playback.device?.id || playback.device.id === providerDeviceId)) {
        return { status: "paused", confirmation: "verified_after_provider_error" };
      }
      throw error;
    }
  }

  async getPlayback() {
    const playback = await this.api("/me/player");
    if (!playback) return { status: "idle", item: null, device: null, source: "spotify" };
    const item = playback.item;
    let image = item?.album?.images?.find((candidate) => candidate?.url) || null;
    if (!image && item?.type === "track" && item.id) {
      image = this.artworkCache.get(item.id) || null;
      if (!image) {
        try {
          const track = await this.api(`/tracks/${encodeURIComponent(item.id)}`);
          image = track?.album?.images?.find((candidate) => candidate?.url) || null;
          if (image) {
            this.artworkCache.set(item.id, image);
            if (this.artworkCache.size > 100) this.artworkCache.delete(this.artworkCache.keys().next().value);
          }
        } catch { /* La reproducción sigue siendo válida aunque no exista portada. */ }
      }
    }
    return {
      status: playback.is_playing ? "playing" : "paused",
      source: "spotify",
      progressMs: playback.progress_ms,
      shuffle: playback.shuffle_state,
      repeat: playback.repeat_state,
      device: playback.device ? {
        id: playback.device.id,
        name: playback.device.name,
        type: playback.device.type,
        volumePercent: playback.device.volume_percent,
        supportsVolume: playback.device.supports_volume
      } : null,
      item: item ? {
        id: item.id || null,
        name: item.name,
        type: item.type,
        durationMs: item.duration_ms,
        artists: (item.artists || []).map((artist) => artist.name),
        album: item.album?.name || null,
        uri: item.uri,
        isrc: item.external_ids?.isrc || null,
        artwork: image ? { url: image.url, width: image.width || null, height: image.height || null, source: "spotify" } : null,
        source: "spotify"
      } : null
    };
  }

  async resume(providerDeviceId) {
    await this.api(`/me/player/play?${new URLSearchParams({ device_id: providerDeviceId })}`, { method: "PUT" });
    return { status: "playing" };
  }

  async next(providerDeviceId) {
    await this.api(`/me/player/next?${new URLSearchParams({ device_id: providerDeviceId })}`, { method: "POST" });
    return { status: "playing", action: "next" };
  }

  async previous(providerDeviceId) {
    await this.api(`/me/player/previous?${new URLSearchParams({ device_id: providerDeviceId })}`, { method: "POST" });
    return { status: "playing", action: "previous" };
  }

  async setVolume(providerDeviceId, volumePercent) {
    const value = Math.max(0, Math.min(100, Math.round(Number(volumePercent))));
    if (!Number.isFinite(value)) throw new Error("El volumen debe ser un porcentaje entre 0 y 100");
    await this.api(`/me/player/volume?${new URLSearchParams({ device_id: providerDeviceId, volume_percent: String(value) })}`, { method: "PUT" });
    return { volumePercent: value };
  }

  async addToQueue(query, providerDeviceId) {
    const search = await this.api(`/search?${new URLSearchParams({ q: query, type: "track", limit: "5" })}`);
    const tracks = (search.tracks?.items || []).filter(Boolean);
    if (!tracks.length) throw new Error(`Spotify no encontró “${query}”`);
    const track = tracks.find((item) => normalized(item.name) === normalized(query)) || tracks[0];
    const existing = await this.getQueue();
    if (existing.queue.some((item) => item.uri === track.uri)) {
      return { queued: { name: track.name, artists: (track.artists || []).map((artist) => artist.name), uri: track.uri }, alreadyQueued: true };
    }
    await this.api(`/me/player/queue?${new URLSearchParams({ uri: track.uri, device_id: providerDeviceId })}`, { method: "POST" });
    return { queued: { name: track.name, artists: (track.artists || []).map((artist) => artist.name), uri: track.uri } };
  }

  async getQueue() {
    const result = await this.api("/me/player/queue");
    const normalizeItem = (item) => item ? {
      name: item.name,
      type: item.type,
      artists: (item.artists || []).map((artist) => artist.name),
      album: item.album?.name || null,
      durationMs: item.duration_ms,
      uri: item.uri
    } : null;
    return {
      current: normalizeItem(result?.currently_playing),
      queue: (result?.queue || []).map(normalizeItem).filter(Boolean)
    };
  }

  async clearQueue(providerDeviceId) {
    const snapshot = await this.getQueue();
    if (!snapshot.queue.length) return { status: "cleared", cleared: 0, remaining: 0 };
    return {
      status: "unsupported",
      cleared: 0,
      remaining: snapshot.queue.length,
      message: "Spotify permite consultar y agregar a la cola, pero su Web API no ofrece una operación para borrar sus elementos. Debes vaciarla desde una aplicación oficial de Spotify."
    };
  }

  async transfer(providerDeviceId, play = true) {
    await this.api("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [providerDeviceId], play: Boolean(play) }) });
    let playback = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      playback = await this.api("/me/player");
      if (playback?.device?.id === providerDeviceId) break;
      await this.sleep(500);
    }
    if (playback?.device?.id !== providerDeviceId) throw new Error("Spotify aceptó la transferencia, pero no activó el dispositivo de destino");
    if (play && !playback.is_playing) {
      await this.api(`/me/player/play?${new URLSearchParams({ device_id: providerDeviceId })}`, { method: "PUT" });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        playback = await this.api("/me/player");
        if (playback?.device?.id === providerDeviceId && playback.is_playing) break;
        await this.sleep(500);
      }
      if (playback?.device?.id !== providerDeviceId || !playback.is_playing) {
        throw new Error("La reproducción se transfirió, pero el dispositivo de destino no comenzó a reproducir");
      }
    }
    return { status: play ? "playing" : "paused", action: "transferred" };
  }
}
