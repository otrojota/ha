const elements = Object.fromEntries([
  "clock", "date", "connection", "weather", "weather-icon", "weather-condition", "moon-phase", "moon-icon", "moon-phase-name", "track", "device", "transcript", "response",
  "playback-cover", "playback-cover-placeholder", "playback-artists", "playback-album", "playback-progress-bar", "playback-time",
  "playback-volume", "playback-volume-value", "playback-previous", "playback-toggle", "playback-next", "playback-controls-status",
  "input-summary", "output-summary", "audio-title", "audio-help", "audio-status", "device-list",
  "channel-status", "channel-list", "audio-level-db", "audio-level-bar", "audio-level-peak",
  "assistant-summary", "assistant-form", "assistant-name", "assistant-status"
  , "voice-summary", "voice-status", "voice-list"
  , "location-summary", "location-form", "location-city", "location-region", "location-country",
  "location-latitude", "location-longitude", "location-time-zone", "location-status", "detect-location"
  , "music-destinations-summary", "music-destinations-status", "music-destinations-list", "discover-music-destinations"
  , "music-destination-title", "music-destination-detail", "music-destination-form", "music-destination-alias"
  , "music-destination-room", "music-destination-enabled", "music-destination-status"
  , "music-sources-menu-summary", "music-sources-summary", "music-sources-status", "music-sources-list"
  , "music-destination-active"
  , "music-player-summary", "music-player-form", "music-player-name", "music-player-output", "music-player-output-list", "music-player-enabled", "music-player-status"
  , "music-assistant-summary", "music-assistant-form", "music-assistant-username", "music-assistant-password", "music-assistant-status"
  , "server-summary", "server-status", "server-list", "discover-servers"
].map((id) => [id, document.getElementById(id)]));

const playbackSource = document.createElement("div");
playbackSource.id = "playback-source";
playbackSource.className = "playback-device";
playbackSource.textContent = "Origen: --";
elements["playback-album"].after(playbackSource);
elements["playback-source"] = playbackSource;
const audioApiUrl = `${location.protocol}//${location.hostname || "localhost"}:3200/audio`;
const assistantApiUrl = `${location.protocol}//${location.hostname || "localhost"}:3200/assistant`;
const serverApiUrl = `${location.protocol}//${location.hostname || "localhost"}:3200`;
let locationApiUrl = null;
let musicApiUrl = null;
let serverState = null;
let displaySocket = null;
let displaySocketGeneration = 0;
let displayReconnectTimer = null;
let audioState = null;
let musicState = null;
let activeMusicDestinationId = null;
let activeAudioKind = "input";
let displayedAudioLevel = 0;
let peakAudioLevel = 0;
let peakHoldUntil = 0;
let playbackSnapshot = null;
let playbackReceivedAt = 0;
let playbackVolumeEditing = false;
let lastNonEmptyPlaybackAt = 0;
let playbackRequestGeneration = 0;

function applyServerState(state) {
  serverState = state;
  const selected = state?.selected;
  locationApiUrl = selected ? `${selected.httpUrl}/config/location` : null;
  musicApiUrl = selected?.musicApiUrl || null;
  elements["server-summary"].textContent = selected
    ? `${selected.name} · ${selected.address}:${selected.port}`
    : state?.selectionRequired ? "Selecciona un servidor" : "Buscando…";
}

async function loadServers({ refresh = false } = {}) {
  elements["server-status"].textContent = refresh ? "Buscando servidores…" : "";
  try {
    const response = await fetch(`${serverApiUrl}${refresh ? "/servers/discover" : "/servers"}`, { method: refresh ? "POST" : "GET" });
    const state = await response.json();
    if (!response.ok) throw new Error(state.message || `HTTP ${response.status}`);
    applyServerState(state);
    renderServers();
    elements["server-status"].textContent = state.selectionRequired
        ? "Hay varios servidores disponibles. Selecciona uno."
        : state.selected
          ? state.manualConfigured && state.selected.manual
            ? "Servidor manual seleccionado; también se buscan servidores en la red."
            : "Servidor disponible."
          : "No se encontraron servidores todavía.";
    return state;
  } catch (error) {
    elements["server-status"].textContent = "No se pudo consultar el descubrimiento del satélite.";
    return null;
  }
}

function renderServers() {
  const servers = serverState?.discovered || [];
  elements["server-list"].replaceChildren(...servers.map((server) => {
    const selected = server.id === serverState.selected?.id;
    const button = document.createElement("button");
    button.className = `device-option${selected ? " selected" : ""}`;
    button.disabled = selected;
    button.innerHTML = `<span><strong></strong><small></small></span><span class="selection-mark">${selected ? "✓" : ""}</span>`;
    button.querySelector("strong").textContent = server.name;
    button.querySelector("small").textContent = `${server.address}:${server.port}${server.manual ? " · Configuración manual" : " · Descubierto en la red"}`;
    button.addEventListener("click", () => selectServer(server.id));
    return button;
  }));
}

async function selectServer(id) {
  elements["server-status"].textContent = "Conectando con el servidor…";
  try {
    const response = await fetch(`${serverApiUrl}/server`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id })
    });
    const state = await response.json();
    if (!response.ok) throw new Error(state.message || `HTTP ${response.status}`);
    applyServerState(state);
    renderServers();
    elements["server-status"].textContent = "Servidor seleccionado.";
    reconnectDisplaySocket();
    void loadCurrentPlayback();
  } catch (error) {
    elements["server-status"].textContent = error.message;
  }
}

function playbackTime(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function updatePlaybackProgress() {
  const item = playbackSnapshot?.item;
  const duration = Number(item?.durationMs || 0);
  let progress = Number(playbackSnapshot?.progressMs || 0);
  if (playbackSnapshot?.status === "playing") progress += Date.now() - playbackReceivedAt;
  progress = duration > 0 ? Math.min(duration, progress) : progress;
  elements["playback-progress-bar"].style.width = duration > 0 ? `${Math.min(100, progress / duration * 100)}%` : "0";
  elements["playback-time"].textContent = duration > 0 ? `${playbackTime(progress)} / ${playbackTime(duration)}` : "";
}

function playbackDestinationLabel(playback) {
  const destinationId = playback.destination?.id || playback.device?.id;
  const configured = musicState?.destinations?.find((item) => item.id === destinationId);
  const destination = configured || playback.destination || {};
  const alias = String(destination.alias || "").trim();
  const room = String(destination.room || "").trim();
  if (alias && room) return `${alias} · ${room}`;
  return alias || room || destination.name || (typeof playback.device === "string" ? playback.device : playback.device?.name) || null;
}

function renderPlayback(playback = {}) {
  const now = Date.now();
  if (!playback.item && playbackSnapshot?.item && now - lastNonEmptyPlaybackAt < 15_000) {
    playback = {
      ...playback,
      item: playbackSnapshot.item,
      status: playback.status === "idle" ? playbackSnapshot.status : playback.status,
      progressMs: playbackSnapshot.progressMs,
      device: playback.device || playbackSnapshot.device,
      destination: playback.destination || playbackSnapshot.destination
    };
  }
  if (playback.item) lastNonEmptyPlaybackAt = now;
  playbackSnapshot = playback;
  playbackReceivedAt = now;
  const item = playback.item;
  elements.track.textContent = item?.name || item?.title || "Sin reproducción";
  elements["playback-artists"].textContent = item?.artists?.join(", ") || "";
  elements["playback-album"].textContent = item?.album || "";
  const providerId = String(item?.provider || "");
  const source = musicState?.sources?.find((entry) => entry.id === providerId || entry.domain === providerId || providerId.startsWith(`${entry.domain}--`));
  const sourceName = source?.name || playback.source?.name || item?.provider || "--";
  elements["playback-source"].textContent = `Origen: ${sourceName}${item?.library ? " · Biblioteca" : ""}`;
  const device = playbackDestinationLabel(playback);
  const status = playback.status === "paused" ? "Pausado" : playback.status === "playing" ? "Reproduciendo" : "Sin reproducción";
  elements.device.textContent = `${status} · ${device || "Sin dispositivo"}`;
  const hasPlayback = Boolean(item);
  elements["playback-previous"].disabled = !hasPlayback;
  elements["playback-next"].disabled = !hasPlayback;
  elements["playback-toggle"].disabled = !hasPlayback;
  const isPlaying = playback.status === "playing";
  elements["playback-toggle"].textContent = isPlaying ? "Ⅱ" : "▶";
  elements["playback-toggle"].setAttribute("aria-label", isPlaying ? "Pausar" : "Reproducir");
  const rawVolume = playback.device?.volumePercent;
  const volume = Number(rawVolume);
  const hasVolume = rawVolume !== null && rawVolume !== undefined && Number.isFinite(volume);
  elements["playback-volume"].disabled = !hasVolume || !musicApiUrl;
  if (!playbackVolumeEditing && hasVolume) elements["playback-volume"].value = String(Math.max(0, Math.min(100, Math.round(volume))));
  elements["playback-volume-value"].textContent = hasVolume ? `${Math.round(volume)}%` : "--";
  updatePlaybackProgress();
  const artworkPath = item?.artworkUrl || item?.artwork?.url;
  const artworkUrl = artworkPath && musicApiUrl ? new URL(artworkPath, `${musicApiUrl}/`).toString() : artworkPath;
  if (artworkUrl && /^https?:\/\//.test(artworkUrl)) {
    elements["playback-cover"].src = artworkUrl;
    elements["playback-cover"].alt = `Portada de ${item.name || "la reproducción actual"}`;
    elements["playback-cover"].classList.add("visible");
    elements["playback-cover-placeholder"].classList.add("hidden");
  } else {
    elements["playback-cover"].removeAttribute("src");
    elements["playback-cover"].classList.remove("visible");
    elements["playback-cover-placeholder"].classList.remove("hidden");
  }
}

async function setPlaybackVolume() {
  if (!musicApiUrl || elements["playback-volume"].disabled) return;
  const volumePercent = Number(elements["playback-volume"].value);
  elements["playback-volume"].disabled = true;
  elements["playback-controls-status"].textContent = `Ajustando volumen a ${volumePercent}%…`;
  try {
    const response = await fetch(`${musicApiUrl}/music/volume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volumePercent })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `Music Gateway respondió HTTP ${response.status}`);
    playbackRequestGeneration += 1;
    renderPlayback(result);
    elements["playback-controls-status"].textContent = "";
  } catch (error) {
    elements["playback-controls-status"].textContent = error.message;
    renderPlayback(playbackSnapshot || {});
  } finally {
    playbackVolumeEditing = false;
  }
}

async function runPlaybackCommand(action) {
  const buttons = [elements["playback-previous"], elements["playback-toggle"], elements["playback-next"]];
  buttons.forEach((button) => { button.disabled = true; });
  elements["playback-controls-status"].textContent = "Actualizando…";
  try {
    const response = await fetch(`${musicApiUrl}/music/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `Music Gateway respondió HTTP ${response.status}`);
    if (action === "pause" || action === "resume") {
      renderPlayback({ ...playbackSnapshot, status: action === "pause" ? "paused" : "playing" });
    }
    elements["playback-controls-status"].textContent = "";
    setTimeout(() => void loadCurrentPlayback(), 500);
  } catch (error) {
    elements["playback-controls-status"].textContent = error.message;
    renderPlayback(playbackSnapshot || {});
  }
}

async function loadCurrentPlayback() {
  if (!musicApiUrl) return false;
  const generation = ++playbackRequestGeneration;
  try {
    const response = await fetch(`${musicApiUrl}/music/playback`, { cache: "no-store" });
    if (!response.ok) return false;
    const playback = await response.json();
    if (generation !== playbackRequestGeneration) return false;
    renderPlayback(playback);
    return true;
  } catch { return false; }
}

function fillLocation(location) {
  elements["location-city"].value = location.city || "";
  elements["location-region"].value = location.region || "";
  elements["location-country"].value = location.country || "";
  elements["location-latitude"].value = location.latitude ?? "";
  elements["location-longitude"].value = location.longitude ?? "";
  elements["location-time-zone"].value = location.timeZone || "";
  elements["location-summary"].textContent = [location.city, location.country].filter(Boolean).join(", ") || "Sin configurar";
}

async function loadLocation() {
  if (!locationApiUrl) {
    elements["location-status"].textContent = "Selecciona primero un servidor disponible.";
    return false;
  }
  try {
    const response = await fetch(locationApiUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { location } = await response.json();
    fillLocation(location);
    elements["location-status"].textContent = "";
    return true;
  } catch (error) {
    elements["location-status"].textContent = "No se pudo cargar la ubicación del servidor.";
    return false;
  }
}

async function detectLocation() {
  elements["detect-location"].disabled = true;
  elements["location-status"].textContent = "Detectando ubicación aproximada…";
  try {
    const response = await fetch(`${locationApiUrl}/detect`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    fillLocation(result.location);
    elements["location-status"].textContent = `Sugerencia por IP: ${result.location.city}. Revisa los datos y presiona Guardar.`;
  } catch (error) {
    elements["location-status"].textContent = "No se pudo detectar la ubicación por IP.";
  } finally {
    elements["detect-location"].disabled = false;
  }
}

async function saveLocation(event) {
  event.preventDefault();
  const button = elements["location-form"].querySelector("button[type=submit]");
  button.disabled = true;
  elements["location-status"].textContent = "Guardando…";
  try {
    const response = await fetch(locationApiUrl, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        city: elements["location-city"].value,
        region: elements["location-region"].value,
        country: elements["location-country"].value,
        latitude: Number(elements["location-latitude"].value),
        longitude: Number(elements["location-longitude"].value),
        timeZone: elements["location-time-zone"].value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    fillLocation(result.location);
    elements["location-status"].textContent = "Ubicación guardada";
  } catch (error) {
    elements["location-status"].textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function loadAssistantConfig() {
  try {
    const response = await fetch(assistantApiUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { config } = await response.json();
    elements["assistant-summary"].textContent = config.name;
    elements["assistant-name"].value = config.name;
    return true;
  } catch (error) {
    elements["assistant-status"].textContent = "No se pudo cargar la configuración del asistente.";
    return false;
  }
}

async function saveAssistantName(event) {
  event.preventDefault();
  const button = elements["assistant-form"].querySelector("button[type=submit]");
  button.disabled = true;
  elements["assistant-status"].textContent = "Validando con Vosk…";
  try {
    const response = await fetch(assistantApiUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: elements["assistant-name"].value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    elements["assistant-name"].value = result.config.name;
    elements["assistant-summary"].textContent = result.config.name;
    elements["assistant-status"].textContent = `Nombre guardado. Di “${result.config.name}” para activarlo.`;
  } catch (error) {
    elements["assistant-status"].textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function updateMusicSummary() {
  if (!musicState) return;
  const count = musicState.summary?.available || 0;
  elements["music-destinations-summary"].textContent = count === 1 ? "1 disponible" : `${count} disponibles`;
  const sources = musicState.sources || [];
  const active = sources.find((item) => item.active || item.id === musicState.activeSourceId);
  const sourceSummary = sources.length ? `Origen activo: ${active?.name || "sin seleccionar"}` : "Sin orígenes configurados";
  elements["music-sources-menu-summary"].textContent = active?.name || (sources.length ? `${sources.length} disponibles` : "Sin configurar");
  elements["music-sources-summary"].textContent = sourceSummary;
  renderMusicSources();
}

function renderMusicSources() {
  const sources = (musicState?.sources || []).filter((source) => source.available !== false);
  elements["music-sources-list"].replaceChildren(...sources.map((source) => {
    const button = document.createElement("button");
    const active = source.active || source.id === musicState.activeSourceId;
    button.className = `destination-card${active ? " active selected" : ""}`;
    button.disabled = active;
    button.innerHTML = '<span class="destination-icon">♫</span><span><strong></strong><small class="destination-meta"></small></span><span class="selection-mark"></span>';
    button.querySelector("strong").textContent = source.name;
    button.querySelector(".destination-meta").textContent = `${source.domain}${active ? " · Origen activo" : ""}`;
    button.querySelector(".selection-mark").textContent = active ? "✓" : "";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch(`${musicApiUrl}/sources/active`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: source.id }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
        musicState.activeSourceId = result.id;
        musicState.sources = musicState.sources.map((item) => ({ ...item, active: item.id === result.id }));
        updateMusicSummary();
      } catch (error) {
        elements["music-sources-status"].textContent = error.message;
        button.disabled = false;
      }
    });
    return button;
  }));
}

function destinationDisplayName(destination) {
  return destination.alias || destination.name;
}

function renderMusicDestinations() {
  const destinations = musicState?.destinations || [];
  elements["music-destinations-list"].replaceChildren(...destinations.map((destination) => {
    const button = document.createElement("button");
    button.className = `destination-card${destination.active ? " active" : ""}${destination.available ? "" : " offline"}`;
    button.type = "button";
    button.innerHTML = '<span class="destination-icon">🔊</span><span><strong></strong><small class="destination-meta"></small><small class="destination-route"></small></span><span class="chevron">›</span>';
    button.querySelector("strong").textContent = destinationDisplayName(destination);
    const meta = button.querySelector(".destination-meta");
    const dot = document.createElement("span");
    dot.className = `availability-dot${destination.available ? " online" : ""}`;
    meta.replaceChildren(dot, document.createTextNode(`${destination.available ? "Disponible" : "Desconectado"}${destination.room ? ` · ${destination.room}` : ""}`));
    button.querySelector(".destination-route").textContent = `${destination.active ? "Activo · " : ""}${destination.provider || "Music Assistant"}`;
    button.addEventListener("click", () => openMusicDestination(destination.id));
    return button;
  }));
  if (!destinations.length) elements["music-destinations-status"].textContent = "Aún no hay destinos disponibles. Inicia una búsqueda para actualizar la lista.";
  updateMusicSummary();
}

async function loadMusicDestinations({ discover = false } = {}) {
  if (!musicApiUrl) {
    elements["music-destinations-status"].textContent = "Selecciona primero un servidor disponible.";
    elements["music-sources-status"].textContent = "Selecciona primero un servidor disponible.";
    return false;
  }
  elements["music-destinations-status"].textContent = discover ? "Buscando reproductores…" : "Cargando destinos…";
  elements["music-sources-status"].textContent = "Cargando orígenes…";
  elements["discover-music-destinations"].disabled = true;
  try {
    const response = await fetch(`${musicApiUrl}/destinations${discover ? "/discover" : ""}`, { method: discover ? "POST" : "GET" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    musicState = result;
    renderMusicDestinations();
    const errors = result.errors || [];
    elements["music-destinations-status"].textContent = errors.length
      ? `Búsqueda terminada con avisos: ${errors.map((item) => item.message).join(" · ")}`
      : (discover ? "Búsqueda terminada" : "");
    elements["music-sources-status"].textContent = "";
    return true;
  } catch (error) {
    elements["music-destinations-status"].textContent = "Music Assistant no está conectado. Configúralo desde Configuración → Music Assistant.";
    elements["music-sources-status"].textContent = "Music Assistant no está conectado. Configúralo desde Configuración → Music Assistant.";
    return false;
  } finally {
    elements["discover-music-destinations"].disabled = false;
  }
}

async function loadMusicAssistantStatus() {
  if (!musicApiUrl) {
    elements["music-assistant-summary"].textContent = "Selecciona un servidor";
    elements["music-assistant-status"].textContent = "Selecciona primero un servidor disponible.";
    return false;
  }
  try {
    const response = await fetch(`${musicApiUrl}/integration/music-assistant`);
    const status = await response.json();
    if (!response.ok) throw new Error(status.message || `HTTP ${response.status}`);
    elements["music-assistant-summary"].textContent = status.connected ? "Conectado" : "Requiere autenticación";
    elements["music-assistant-status"].textContent = status.connected
      ? "Music Gateway está autenticado y listo para controlar Music Assistant."
      : `Inicia sesión para autorizar Music Gateway. ${status.message || ""}`.trim();
    elements["music-assistant-form"].hidden = status.connected;
    return status.connected;
  } catch (error) {
    elements["music-assistant-summary"].textContent = "No disponible";
    elements["music-assistant-status"].textContent = "No se pudo consultar Music Gateway.";
    elements["music-assistant-form"].hidden = false;
    return false;
  }
}

async function connectMusicAssistant(event) {
  event.preventDefault();
  const button = elements["music-assistant-form"].querySelector("button[type=submit]");
  button.disabled = true;
  elements["music-assistant-status"].textContent = "Autenticando y creando token…";
  try {
    const response = await fetch(`${musicApiUrl}/integration/music-assistant/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: elements["music-assistant-username"].value,
        password: elements["music-assistant-password"].value
      })
    });
    const result = await response.json();
    elements["music-assistant-password"].value = "";
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    await loadMusicAssistantStatus();
    await loadMusicDestinations();
  } catch (error) {
    elements["music-assistant-password"].value = "";
    elements["music-assistant-status"].textContent = error.message;
  } finally { button.disabled = false; }
}

function openMusicDestination(id) {
  const destination = musicState?.destinations.find((item) => item.id === id);
  if (!destination) return;
  activeMusicDestinationId = id;
  elements["music-destination-title"].textContent = destinationDisplayName(destination);
  elements["music-destination-alias"].value = destination.alias || "";
  elements["music-destination-room"].value = destination.room || "";
  elements["music-destination-enabled"].checked = destination.enabled !== false;
  elements["music-destination-active"].textContent = destination.active ? "Destino activo" : "Usar como destino activo";
  elements["music-destination-active"].disabled = Boolean(destination.active) || destination.enabled === false;
  elements["music-destination-detail"].textContent = [destination.name, destination.model, `Proveedor de destino MA: ${destination.provider}`].filter(Boolean).join(" · ");
  elements["music-destination-status"].textContent = "";
  showScreen("music-destination-screen");
}

async function setActiveMusicDestination() {
  if (!activeMusicDestinationId) return;
  elements["music-destination-active"].disabled = true;
  elements["music-destination-status"].textContent = "Cambiando destino activo…";
  try {
    const response = await fetch(`${musicApiUrl}/destinations/active`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: activeMusicDestinationId })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    musicState.activeDestinationId = result.id;
    musicState.destinations = musicState.destinations.map((item) => ({ ...item, active: item.id === result.id }));
    elements["music-destination-active"].textContent = "Destino activo";
    elements["music-destination-status"].textContent = result.transferred
      ? `La reproducción se transfirió a ${destinationDisplayName(result)}`
      : `${destinationDisplayName(result)} es ahora el destino activo`;
    if (result.playback) {
      playbackRequestGeneration += 1;
      renderPlayback({ ...result.playback, destination: result });
    }
    renderMusicDestinations();
  } catch (error) {
    elements["music-destination-active"].disabled = false;
    elements["music-destination-status"].textContent = error.message;
  }
}

async function saveMusicDestination(event) {
  event.preventDefault();
  if (!activeMusicDestinationId) return;
  const button = elements["music-destination-form"].querySelector("button[type=submit]");
  button.disabled = true;
  elements["music-destination-status"].textContent = "Guardando…";
  try {
    const response = await fetch(`${musicApiUrl}/destinations/${encodeURIComponent(activeMusicDestinationId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alias: elements["music-destination-alias"].value,
        room: elements["music-destination-room"].value,
        enabled: elements["music-destination-enabled"].checked
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    const index = musicState.destinations.findIndex((item) => item.id === result.id);
    if (index >= 0) musicState.destinations[index] = result;
    elements["music-destination-title"].textContent = destinationDisplayName(result);
    elements["music-destination-status"].textContent = "Destino guardado";
    renderMusicDestinations();
  } catch (error) {
    elements["music-destination-status"].textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function updateAudioMeter({ level = 0, db = -60, clipping = false }) {
  displayedAudioLevel = displayedAudioLevel * 0.35 + level * 0.65;
  if (displayedAudioLevel >= peakAudioLevel || performance.now() > peakHoldUntil) {
    peakAudioLevel = displayedAudioLevel;
    peakHoldUntil = performance.now() + 550;
  } else {
    peakAudioLevel = Math.max(displayedAudioLevel, peakAudioLevel - 0.025);
  }
  elements["audio-level-bar"].style.width = `${displayedAudioLevel * 100}%`;
  elements["audio-level-peak"].style.left = `${peakAudioLevel * 100}%`;
  elements["audio-level-db"].textContent = `${Math.round(db)} dB`;
  elements["audio-level-bar"].closest(".audio-meter").classList.toggle("clipping", clipping);
}

function updateClock() {
  const now = new Date();
  elements.clock.textContent = now.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
  elements.date.textContent = now.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" });
}

function showScreen(id) {
  window.virtualKeyboard?.hide();
  document.querySelectorAll(".screen").forEach((screen) => screen.classList.toggle("active", screen.id === id));
}

function deviceName(kind, id) {
  return audioState?.devices[kind].find((device) => device.id === id)?.name || (id ? "Dispositivo no disponible" : (kind === "input" ? "Entrada predeterminada" : "Salida predeterminada"));
}

function updateAudioSummaries() {
  if (!audioState) return;
  const effective = audioState.effectiveConfig || audioState.config;
  const channel = Number.isInteger(effective.inputChannel) ? ` · Canal ${effective.inputChannel + 1}` : "";
  const inputFallback = effective.inputDeviceId !== audioState.config.inputDeviceId ? " · fallback" : "";
  const outputFallback = effective.outputDeviceId !== audioState.config.outputDeviceId ? " · fallback" : "";
  elements["input-summary"].textContent = `${deviceName("input", effective.inputDeviceId)}${channel}${inputFallback}`;
  elements["output-summary"].textContent = `${deviceName("output", effective.outputDeviceId)}${outputFallback}`;
  const voice = audioState.voices?.find((item) => item.id === audioState.config.ttsVoiceId) || audioState.voices?.[0];
  elements["voice-summary"].textContent = voice?.name || "Sin voces disponibles";
  const player = audioState.musicPlayer;
  elements["music-player-summary"].textContent = player?.enabled ? `${player.name} · ${player.running ? "Activo" : "No iniciado"}` : "Deshabilitado";
}

async function loadAudio() {
  elements["audio-status"].textContent = "Buscando dispositivos…";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(audioApiUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    audioState = await response.json();
    elements["audio-status"].textContent = "";
    updateAudioSummaries();
    return true;
  } catch (error) {
    elements["audio-status"].textContent = error.name === "AbortError"
      ? "La búsqueda de dispositivos tardó demasiado. Intenta nuevamente."
      : "No se pudo conectar con el servicio de audio del satélite.";
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function fillMusicPlayer() {
  if (!audioState) return;
  elements["music-player-name"].value = audioState.config.musicPlayerName || audioState.musicPlayer?.name || "Satélite";
  elements["music-player-output"].value = audioState.config.musicOutputDeviceId || "";
  renderMusicPlayerOutputs();
  elements["music-player-enabled"].checked = audioState.config.musicPlayerEnabled !== false;
  elements["music-player-status"].textContent = audioState.musicPlayer?.running
    ? "Sendspin está activo y disponible para Music Assistant."
    : (audioState.config.musicPlayerEnabled === false ? "El reproductor está deshabilitado." : (audioState.musicPlayer?.error || "Sendspin no está activo. Comprueba que esté instalado en el satélite."));
}

function renderMusicPlayerOutputs() {
  const selected = elements["music-player-output"].value;
  const outputs = [
    { id: "", name: "Salida predeterminada", description: "Sendspin utilizará la salida predeterminada del sistema" },
    ...(audioState?.devices.output || []).map((device) => ({ id: device.name, name: device.name, description: device.available === false ? "No disponible" : "Disponible", available: device.available !== false }))
  ];
  if (selected && !outputs.some((item) => item.id === selected)) outputs.push({ id: selected, name: selected, description: "Configuración guardada anteriormente", available: true });
  elements["music-player-output-list"].replaceChildren(...outputs.map((output) => {
    const active = output.id === selected;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `device-option${active ? " selected" : ""}`;
    button.disabled = output.available === false;
    button.innerHTML = `<span><strong></strong><small></small></span><span class="selection-mark">${active ? "✓" : ""}</span>`;
    button.querySelector("strong").textContent = output.name;
    button.querySelector("small").textContent = output.description;
    button.addEventListener("click", () => {
      elements["music-player-output"].value = output.id;
      renderMusicPlayerOutputs();
    });
    return button;
  }));
}

async function saveMusicPlayer(event) {
  event.preventDefault();
  const button = elements["music-player-form"].querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await saveConfig({
      musicPlayerName: elements["music-player-name"].value,
      musicOutputDeviceId: elements["music-player-output"].value || null,
      musicPlayerEnabled: elements["music-player-enabled"].checked
    }, elements["music-player-status"]);
    await loadAudio();
    fillMusicPlayer();
    elements["music-player-status"].textContent = "Configuración guardada. Music Assistant puede tardar unos segundos en actualizar el destino.";
  } catch (error) {
    elements["music-player-status"].textContent = error.message;
  } finally { button.disabled = false; }
}

function renderDevices() {
  const configKey = activeAudioKind === "input" ? "inputDeviceId" : "outputDeviceId";
  const listKey = activeAudioKind === "input" ? "inputDeviceIds" : "outputDeviceIds";
  const selectedId = audioState.config[configKey];
  const effectiveId = (audioState.effectiveConfig || audioState.config)[configKey];
  const priorities = audioState.config[listKey] || [];
  const defaultOption = { id: null, name: activeAudioKind === "input" ? "Entrada predeterminada" : "Salida predeterminada", available: true, isDefault: true };
  elements["device-list"].replaceChildren(...[defaultOption, ...audioState.devices[activeAudioKind]].map((device) => {
    const button = document.createElement("button");
    button.className = `device-option${device.id === selectedId ? " selected" : ""}`;
    button.disabled = !device.available;
    button.innerHTML = `<span><strong></strong><small></small></span><span class="selection-mark">${device.id === selectedId ? "✓" : ""}</span>`;
    button.querySelector("strong").textContent = device.name;
    const priority = priorities.indexOf(device.id);
    button.querySelector("small").textContent = device.isDefault ? "Usa el dispositivo predeterminado del sistema" : (device.simulated ? "Modo simulador" : `${device.available ? "Disponible" : "No disponible"}${priority >= 0 ? ` · Prioridad ${priority + 1}` : ""}${device.id === effectiveId ? " · En uso" : ""}`);
    button.addEventListener("click", () => selectDevice(configKey, device.id));
    return button;
  }));
}

async function openAudio(kind) {
  activeAudioKind = kind;
  showScreen("audio-screen");
  elements["audio-title"].textContent = kind === "input" ? "Micrófono" : "Salida de voz";
  elements["audio-help"].textContent = kind === "input"
    ? "Elige el micrófono preferido. Los seleccionados anteriormente quedan como fallback por orden de prioridad."
    : "Elige la salida preferida. Las seleccionadas anteriormente quedan como fallback por orden de prioridad.";
  elements["device-list"].replaceChildren();
  if (await loadAudio()) renderDevices();
}

async function saveConfig(update, statusElement = elements["audio-status"]) {
  statusElement.textContent = "Guardando…";
  const response = await fetch(audioApiUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
  audioState.config = result.config;
  if (result.effectiveConfig) audioState.effectiveConfig = result.effectiveConfig;
  updateAudioSummaries();
}

async function selectDevice(configKey, deviceId) {
  elements["audio-status"].textContent = "Guardando…";
  document.querySelectorAll(".device-option").forEach((button) => { button.disabled = true; });
  try {
    await saveConfig({ [configKey]: deviceId });
    if (configKey === "inputDeviceId") {
      if (deviceId === null) {
        await saveConfig({ inputChannel: 0 });
        elements["audio-status"].textContent = "Entrada predeterminada guardada";
        renderDevices();
        return;
      }
      await selectInputChannel(deviceId);
      return;
    }
    elements["audio-status"].textContent = "Dispositivo guardado";
    renderDevices();
    setTimeout(() => { if (elements["audio-status"].textContent === "Dispositivo guardado") elements["audio-status"].textContent = ""; }, 1800);
  } catch (error) {
    elements["audio-status"].textContent = "No se pudo guardar. Intenta nuevamente.";
    renderDevices();
  }
}

async function selectInputChannel(deviceId) {
  elements["audio-status"].textContent = "Consultando canales…";
  try {
    const response = await fetch(`${audioApiUrl}/input-channels?deviceId=${encodeURIComponent(deviceId)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { channels } = await response.json();
    if (channels.length <= 1) {
      await saveConfig({ inputChannel: channels[0]?.id ?? 0 });
      elements["audio-status"].textContent = "Dispositivo guardado";
      renderDevices();
      return;
    }
    renderChannels(channels);
    elements["audio-status"].textContent = "";
    showScreen("channel-screen");
  } catch (error) {
    elements["audio-status"].textContent = "No se pudieron consultar los canales de este dispositivo.";
    renderDevices();
  }
}

function renderChannels(channels) {
  elements["channel-status"].textContent = "";
  elements["channel-list"].replaceChildren(...channels.map((channel) => {
    const selected = channel.id === audioState.config.inputChannel;
    const button = document.createElement("button");
    button.className = `device-option${selected ? " selected" : ""}`;
    button.innerHTML = `<span><strong></strong><small>Entrada independiente</small></span><span class="selection-mark">${selected ? "✓" : ""}</span>`;
    button.querySelector("strong").textContent = channel.name;
    button.addEventListener("click", async () => {
      document.querySelectorAll("#channel-list .device-option").forEach((option) => { option.disabled = true; });
      try {
        await saveConfig({ inputChannel: channel.id }, elements["channel-status"]);
        renderChannels(channels);
        elements["channel-status"].textContent = "Canal guardado";
      } catch (error) {
        renderChannels(channels);
        elements["channel-status"].textContent = "No se pudo guardar el canal.";
      }
    });
    return button;
  }));
}

function renderVoices() {
  const voices = audioState?.voices || [];
  elements["voice-list"].replaceChildren(...voices.map((voice, index) => {
    const selected = voice.id === audioState.config.ttsVoiceId || (!audioState.config.ttsVoiceId && index === 0);
    const button = document.createElement("button");
    button.className = `device-option${selected ? " selected" : ""}`;
    button.innerHTML = `<span><strong></strong><small></small></span><span class="selection-mark">${selected ? "✓" : ""}</span>`;
    button.querySelector("strong").textContent = voice.name;
    button.querySelector("small").textContent = voice.language ? `Idioma: ${voice.language}` : "Voz local";
    button.addEventListener("click", async () => {
      document.querySelectorAll("#voice-list .device-option").forEach((option) => { option.disabled = true; });
      try {
        await saveConfig({ ttsVoiceId: voice.id }, elements["voice-status"]);
        elements["voice-status"].textContent = "Voz guardada";
        renderVoices();
      } catch (error) {
        elements["voice-status"].textContent = "No se pudo guardar la voz.";
        renderVoices();
      }
    });
    return button;
  }));
  if (!voices.length) elements["voice-status"].textContent = "No hay voces instaladas para esta plataforma.";
}

async function openVoices() {
  showScreen("voice-screen");
  elements["voice-status"].textContent = "Buscando voces locales…";
  elements["voice-list"].replaceChildren();
  if (await loadAudio()) {
    elements["voice-status"].textContent = "";
    renderVoices();
  }
}

function reconnectDisplaySocket() {
  displaySocketGeneration += 1;
  clearTimeout(displayReconnectTimer);
  displayReconnectTimer = null;
  if (displaySocket) {
    const previous = displaySocket;
    displaySocket = null;
    previous.close();
  }
  connect(displaySocketGeneration);
}

async function connect(generation = displaySocketGeneration) {
  let listeningGeneration = 0;
  if (!serverState?.selected) await loadServers();
  const selected = serverState?.selected;
  if (!selected || generation !== displaySocketGeneration) {
    elements.connection.className = "badge text-bg-warning";
    elements.connection.textContent = serverState?.selectionRequired ? "Selecciona servidor" : "Buscando servidor";
    displayReconnectTimer = setTimeout(() => { displayReconnectTimer = null; connect(generation); }, 3000);
    return;
  }
  const socket = new WebSocket(selected.webSocketUrl);
  displaySocket = socket;
  socket.addEventListener("open", () => { elements.connection.className = "badge text-bg-success"; elements.connection.textContent = "Conectado"; });
  socket.addEventListener("close", () => {
    if (displaySocket === socket) displaySocket = null;
    if (generation !== displaySocketGeneration) return;
    elements.connection.className = "badge text-bg-danger";
    elements.connection.textContent = "Desconectado";
    updateAudioMeter({});
    displayReconnectTimer = setTimeout(() => { displayReconnectTimer = null; connect(generation); }, 3000);
  });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "voice.transcript.received") {
      listeningGeneration += 1;
      elements.transcript.textContent = event.payload.text;
    }
    if (event.type === "voice.wake-word.detected") {
      const generation = ++listeningGeneration;
      elements.transcript.textContent = "Escuchando…";
      setTimeout(() => {
        if (listeningGeneration === generation && elements.transcript.textContent === "Escuchando…") elements.transcript.textContent = "Esperando voz…";
      }, Number(event.payload.timeoutMs) || 4000);
    }
    if (event.type === "voice.listening.ended") {
      const generation = ++listeningGeneration;
      elements.transcript.textContent = event.payload.reason === "timeout" ? "No escuché ningún comando." : "No pude entenderte.";
      setTimeout(() => {
        if (listeningGeneration === generation) elements.transcript.textContent = "Esperando voz…";
      }, 2500);
    }
    if (event.type === "voice.follow-up-listening.started") {
      const generation = ++listeningGeneration;
      elements.transcript.textContent = "Puedes responder…";
      setTimeout(() => {
        if (listeningGeneration === generation && elements.transcript.textContent === "Puedes responder…") elements.transcript.textContent = "Esperando voz…";
      }, 5000);
    }
    if (event.type === "audio.level.updated") updateAudioMeter(event.payload);
    if (event.type === "assistant.processing.started") {
      elements.response.textContent = event.payload.text;
      elements.response.classList.add("processing");
    }
    if (event.type === "assistant.response.created") {
      elements.response.textContent = event.payload.text;
      elements.response.classList.remove("processing");
    }
    if (event.type === "weather.updated") {
      elements.weather.textContent = `${Math.round(event.payload.temperature)}°`;
      elements["weather-icon"].textContent = event.payload.icon || "🌡️";
      elements["weather-icon"].setAttribute("aria-label", event.payload.condition || "Estado del clima");
      elements["weather-condition"].textContent = `${event.payload.condition} · Sensación ${Math.round(event.payload.apparentTemperature)}°`;
      elements["moon-icon"].textContent = event.payload.moonPhase?.icon || "🌑";
      elements["moon-icon"].setAttribute("aria-label", event.payload.moonPhase?.name || "Fase lunar");
      elements["moon-phase-name"].textContent = event.payload.moonPhase?.name || "Fase lunar";
    }
    if (event.type === "music.playback.changed") {
      playbackRequestGeneration += 1;
      renderPlayback(event.payload);
    }
  });
}

document.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", async () => {
  showScreen(button.dataset.screen);
  if (button.dataset.screen === "settings-screen") {
    await loadServers();
    await Promise.all([loadAudio(), loadAssistantConfig(), loadLocation(), loadMusicAssistantStatus(), loadMusicDestinations()]);
  }
  if (button.dataset.screen === "server-screen") await loadServers();
  if (button.dataset.screen === "assistant-screen") await loadAssistantConfig();
  if (button.dataset.screen === "voice-screen") await openVoices();
  if (button.dataset.screen === "location-screen") await loadLocation();
  if (button.dataset.screen === "music-destinations-screen") await loadMusicDestinations();
  if (button.dataset.screen === "music-sources-screen") await loadMusicDestinations();
  if (button.dataset.screen === "music-assistant-screen") await loadMusicAssistantStatus();
  if (button.dataset.screen === "music-player-screen") { await loadAudio(); fillMusicPlayer(); }
}));
document.querySelectorAll("[data-audio-kind]").forEach((button) => button.addEventListener("click", () => openAudio(button.dataset.audioKind)));
elements["assistant-form"].addEventListener("submit", saveAssistantName);
elements["location-form"].addEventListener("submit", saveLocation);
elements["detect-location"].addEventListener("click", detectLocation);
elements["discover-music-destinations"].addEventListener("click", () => loadMusicDestinations({ discover: true }));
elements["discover-servers"].addEventListener("click", async () => {
  elements["discover-servers"].disabled = true;
  await loadServers({ refresh: true });
  elements["discover-servers"].disabled = false;
});
elements["music-destination-form"].addEventListener("submit", saveMusicDestination);
elements["music-destination-active"].addEventListener("click", setActiveMusicDestination);
elements["music-player-form"].addEventListener("submit", saveMusicPlayer);
elements["music-assistant-form"].addEventListener("submit", connectMusicAssistant);
elements["playback-previous"].addEventListener("click", () => runPlaybackCommand("previous"));
elements["playback-toggle"].addEventListener("click", () => runPlaybackCommand(playbackSnapshot?.status === "playing" ? "pause" : "resume"));
elements["playback-next"].addEventListener("click", () => runPlaybackCommand("next"));
elements["playback-volume"].addEventListener("pointerdown", () => { playbackVolumeEditing = true; });
elements["playback-volume"].addEventListener("input", () => {
  playbackVolumeEditing = true;
  elements["playback-volume-value"].textContent = `${elements["playback-volume"].value}%`;
});
elements["playback-volume"].addEventListener("change", () => void setPlaybackVolume());
elements["playback-volume"].addEventListener("pointerup", () => { playbackVolumeEditing = false; });
elements["playback-volume"].addEventListener("pointercancel", () => { playbackVolumeEditing = false; });
elements["playback-volume"].addEventListener("blur", () => { playbackVolumeEditing = false; });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void loadCurrentPlayback();
});
window.addEventListener("focus", () => void loadCurrentPlayback());

updateClock();
setInterval(updateClock, 1000);
elements["playback-cover"].addEventListener("error", () => {
  elements["playback-cover"].classList.remove("visible");
  elements["playback-cover-placeholder"].classList.remove("hidden");
});
void (async () => {
  await loadServers();
  await loadCurrentPlayback();
  connect();
})();
setInterval(() => { if (!document.hidden) void loadCurrentPlayback(); }, 2_000);
setInterval(() => { if (musicApiUrl) void loadMusicAssistantStatus(); }, 30_000);
setInterval(updatePlaybackProgress, 1000);
