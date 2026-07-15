import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const defaultState = Object.freeze({
  integrations: {
    spotify: {
      clientId: "",
      redirectUri: "http://127.0.0.1:3100/v1/integrations/spotify/callback",
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
      scope: ""
    }
  },
  activeDestinationId: null,
  destinations: []
});

function cleanText(value, maxLength = 100) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizedDestinationLabel(value) {
  return String(value || "")
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function publicIntegrationConfig(config) {
  return {
    clientId: config.clientId || "",
    redirectUri: config.redirectUri,
    connected: Boolean(config.refreshToken || config.accessToken)
  };
}

export class DestinationStore {
  constructor(path) {
    this.path = path;
    this.state = structuredClone(defaultState);
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.path, "utf8"));
      this.state = {
        integrations: {
          spotify: { ...defaultState.integrations.spotify, ...saved.integrations?.spotify }
        },
        activeDestinationId: saved.activeDestinationId || null,
        destinations: Array.isArray(saved.destinations)
          ? saved.destinations.filter((item) => !["music-assistant", "simulator"].includes(item.source))
          : []
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!this.state.destinations.some((item) => item.id === this.state.activeDestinationId && item.enabled !== false)) {
      this.state.activeDestinationId = this.state.destinations.find((item) => item.enabled !== false)?.id || null;
    }
    return this.state;
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`);
    await rename(temporaryPath, this.path);
  }

  getSpotifyIntegration() {
    return this.state.integrations.spotify;
  }

  async updateSpotifyIntegration(update) {
    const current = this.getSpotifyIntegration();
    const redirectUri = cleanText(update.redirectUri ?? current.redirectUri, 500);
    if (!/^https:\/\//.test(redirectUri) && !/^http:\/\/(127\.0\.0\.1|\[::1\])(?::\d+)?\//.test(redirectUri)) {
      throw new Error("Spotify exige HTTPS o una dirección loopback explícita como 127.0.0.1");
    }
    this.state.integrations.spotify = {
      ...current,
      clientId: cleanText(update.clientId ?? current.clientId, 200),
      redirectUri,
      accessToken: update.accessToken ?? current.accessToken,
      refreshToken: update.refreshToken ?? current.refreshToken,
      expiresAt: update.expiresAt ?? current.expiresAt,
      scope: update.scope ?? current.scope
    };
    if (update.disconnect) Object.assign(this.state.integrations.spotify, { accessToken: "", refreshToken: "", expiresAt: 0, scope: "" });
    await this.save();
    return this.getSpotifyIntegration();
  }

  listDestinations() {
    return this.state.destinations.map((item) => ({ ...item, active: item.id === this.state.activeDestinationId }));
  }

  getActiveDestination() {
    return this.listDestinations().find((item) => item.active) || null;
  }

  resolveDestination(query) {
    if (!query) return this.getActiveDestination();
    const normalized = normalizedDestinationLabel(query);
    const compact = normalized.replace(/\s/g, "");
    const enabled = this.listDestinations().filter((item) => item.enabled !== false);
    const labels = (item) => [item.alias, item.name, item.room].filter(Boolean).map(normalizedDestinationLabel);
    const exact = enabled.filter((item) => labels(item).some((label) => label === normalized || label.replace(/\s/g, "") === compact));
    const matches = exact.length ? exact : enabled.filter((item) => labels(item).some((label) => {
      const compactLabel = label.replace(/\s/g, "");
      return label.includes(normalized) || normalized.includes(label) || compactLabel.includes(compact) || compact.includes(compactLabel);
    }));
    if (!matches.length) throw new Error(`No existe un destino agregado que coincida con “${query}”`);
    if (matches.length > 1) throw new Error(`El destino “${query}” es ambiguo: ${matches.map((item) => item.alias || item.name).join(", ")}`);
    return matches[0];
  }

  async setActiveDestination(idOrQuery) {
    const destination = this.state.destinations.find((item) => item.id === idOrQuery)
      || this.resolveDestination(idOrQuery);
    if (!destination) throw new Error("No hay destinos de música agregados");
    if (destination.enabled === false) throw new Error("El destino está deshabilitado");
    this.state.activeDestinationId = destination.id;
    await this.save();
    return { ...destination, active: true };
  }

  async mergeDiscovered(discovered) {
    const now = new Date().toISOString();
    const foundIds = new Set(discovered.map((item) => item.id));
    const existing = new Map(this.state.destinations.map((item) => [item.id, item]));

    for (const item of discovered) {
      const saved = existing.get(item.id);
      existing.set(item.id, {
        ...saved,
        ...item,
        alias: saved?.alias || "",
        room: saved?.room || "",
        enabled: saved?.enabled ?? true,
        preferredRouteId: saved?.preferredRouteId && item.routes.some((route) => route.id === saved.preferredRouteId)
          ? saved.preferredRouteId
          : item.routes.find((route) => route.available)?.id || item.routes[0]?.id || null,
        lastSeenAt: now
      });
    }

    this.state.destinations = [...existing.values()].map((item) => foundIds.has(item.id) ? item : { ...item, available: false });
    await this.save();
    return this.state.destinations;
  }

  async addDestination(discovered) {
    if (!discovered?.id || !String(discovered.id).startsWith("spotify:")) throw new Error("Destino Spotify inválido");
    const existing = this.state.destinations.find((item) => item.id === discovered.id);
    const destination = {
      ...existing,
      ...discovered,
      alias: existing?.alias || "",
      room: existing?.room || "",
      enabled: existing?.enabled ?? true,
      preferredRouteId: existing?.preferredRouteId || discovered.routes?.[0]?.id || null,
      lastSeenAt: new Date().toISOString()
    };
    if (existing) Object.assign(existing, destination);
    else this.state.destinations.push(destination);
    if (!this.state.activeDestinationId) this.state.activeDestinationId = destination.id;
    await this.save();
    return { ...destination, active: destination.id === this.state.activeDestinationId };
  }

  async updateSpotifyAvailability(discovered) {
    const found = new Map(discovered.map((item) => [item.id, item]));
    for (const destination of this.state.destinations) {
      if (destination.source !== "spotify-connect") continue;
      const current = found.get(destination.id);
      destination.available = Boolean(current);
      if (current) {
        destination.name = current.name;
        destination.model = current.model;
        destination.restricted = current.restricted;
        destination.routes = current.routes;
        destination.lastSeenAt = new Date().toISOString();
      }
    }
    await this.save();
  }

  async updateDestination(id, update) {
    const destination = this.state.destinations.find((item) => item.id === id);
    if (!destination) throw new Error("Destino no encontrado");
    const preferredRouteId = update.preferredRouteId ?? destination.preferredRouteId;
    if (preferredRouteId && !destination.routes.some((route) => route.id === preferredRouteId)) {
      throw new Error("La ruta seleccionada no pertenece a este destino");
    }
    destination.alias = cleanText(update.alias ?? destination.alias, 80);
    destination.room = cleanText(update.room ?? destination.room, 80);
    destination.enabled = update.enabled === undefined ? destination.enabled : Boolean(update.enabled);
    if (!destination.enabled && this.state.activeDestinationId === destination.id) {
      this.state.activeDestinationId = this.state.destinations.find((item) => item.id !== destination.id && item.enabled !== false)?.id || null;
    }
    destination.preferredRouteId = preferredRouteId || null;
    await this.save();
    return { ...destination, active: destination.id === this.state.activeDestinationId };
  }
}
