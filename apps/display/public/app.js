const elements = Object.fromEntries([
  "clock", "date", "connection", "weather", "weather-icon", "weather-condition", "moon-phase", "moon-icon", "moon-phase-name", "track", "device", "transcript", "response",
  "playback-cover", "playback-cover-placeholder", "playback-artists", "playback-album", "playback-progress-bar", "playback-time",
  "playback-volume", "playback-volume-value", "playback-previous", "playback-toggle", "playback-next", "playback-controls-status",
  "input-summary", "output-summary", "audio-title", "audio-help", "audio-status", "device-list",
  "channel-status", "channel-list", "audio-level-db", "audio-level-bar", "audio-level-peak", "conversation-panel", "listening-indicator", "listening-label",
  "assistant-summary", "assistant-form", "assistant-name", "assistant-status"
  , "wake-word-enabled", "manual-listen"
  , "voice-summary", "voice-status", "voice-list"
  , "location-summary", "location-form", "location-city", "location-region", "location-country",
  "location-latitude", "location-longitude", "location-time-zone", "location-status", "detect-location"
  , "llm-summary", "llm-form", "llm-provider", "llm-base-url-field", "llm-base-url", "llm-model",
  "llm-api-key-field", "llm-api-key", "llm-credential-status", "llm-temperature", "llm-context-field",
  "llm-context-length", "llm-keep-alive-field", "llm-keep-alive", "llm-think-field", "llm-think",
  "llm-test", "llm-delete-credential", "llm-status"
  , "music-destinations-summary", "music-destinations-status", "music-destinations-list", "discover-music-destinations"
  , "music-sources-menu-summary", "music-sources-summary", "music-sources-status", "music-sources-list"
  , "music-player-summary", "music-player-form", "music-player-output", "music-player-output-list", "music-player-enabled", "music-player-status"
  , "music-assistant-summary", "music-assistant-form", "music-assistant-username", "music-assistant-password", "music-assistant-status"
  , "server-summary", "server-status", "server-list", "discover-servers"
  , "home-devices-summary", "home-devices-status", "home-devices-list"
  , "home-assistant-form", "home-assistant-url", "home-assistant-token", "home-assistant-credential-status",
  "home-assistant-test", "home-assistant-delete-credential", "home-assistant-status",
  "home-automation-setting", "system-info-summary", "system-info-status", "system-info-grid", "refresh-system-info"
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
const systemApiUrl = `${serverApiUrl}/system`;
const localEventsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.hostname || "localhost"}:3200/events`;
let locationApiUrl = null;
let llmApiUrl = null;
let homeApiUrl = null;
let musicApiUrl = null;
let localSatelliteId = null;
let serverState = null;
let displaySocket = null;
let displaySocketGeneration = 0;
let displayReconnectTimer = null;
let localEventsSocket = null;
let localEventsReconnectTimer = null;
let audioState = null;
let musicState = null;
let activeAudioKind = "input";
let displayedAudioLevel = 0;
let peakAudioLevel = 0;
let peakHoldUntil = 0;
let lastAudioMeterUpdateAt = 0;
let playbackSnapshot = null;
let playbackReceivedAt = 0;
let playbackVolumeEditing = false;
let lastNonEmptyPlaybackAt = 0;
let playbackRequestGeneration = 0;
let llmCredentialConfigured = false;
let homeState = { floors: [], rooms: [], devices: [], refreshedAt: null, stale: true };
let homeAssistantCredentialConfigured = false;
let manualListenRequestPending = false;

const llmProviderDefaults = {
  ollama: { baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:9b" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  "github-models": { baseUrl: "https://models.github.ai/inference", model: "openai/gpt-4.1" },
  "openai-compatible": { baseUrl: "", model: "" }
};

function weatherIconSvg(code, isDay) {
  const value = Number(code);
  const cloud = '<path d="M14 34h22a8 8 0 0 0 .4-16 12 12 0 0 0-22.7 3.2A6.5 6.5 0 0 0 14 34Z" fill="#b9c9dc" stroke="#eef6ff" stroke-width="1.5"/>';
  const wrap = (content) => `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">${content}</svg>`;
  if (value === 0) return wrap(isDay
    ? '<g fill="none" stroke="#ffd166" stroke-linecap="round" stroke-width="3"><circle cx="24" cy="24" r="8" fill="#ffd166"/><path d="M24 5v5M24 38v5M5 24h5M38 24h5M10.5 10.5l3.5 3.5M34 34l3.5 3.5M37.5 10.5 34 14M14 34l-3.5 3.5"/></g>'
    : '<path d="M31 37A15 15 0 0 1 18 11a13 13 0 1 0 13 26Z" fill="#dcecff"/>');
  if ([45, 48].includes(value)) return wrap(`${cloud}<g stroke="#9fb4ca" stroke-linecap="round" stroke-width="2.5"><path d="M9 39h28"/><path d="M14 44h25"/></g>`);
  if ((value >= 51 && value <= 67) || (value >= 80 && value <= 82)) return wrap(`${cloud}<g stroke="#65b9ff" stroke-linecap="round" stroke-width="3"><path d="m17 38-2 5"/><path d="m25 38-2 5"/><path d="m33 38-2 5"/></g>`);
  if ((value >= 71 && value <= 77) || value === 85 || value === 86) return wrap(`${cloud}<g fill="#eef6ff"><circle cx="16" cy="41" r="2"/><circle cx="25" cy="43" r="2"/><circle cx="34" cy="40" r="2"/></g>`);
  if (value >= 95) return wrap(`${cloud}<path d="m27 34-7 9h6l-2 5 9-11h-6l3-3Z" fill="#ffd166"/>`);
  return wrap(`${isDay ? '<circle cx="15" cy="16" r="8" fill="#ffd166"/>' : '<path d="M20 22A9 9 0 0 1 14 8a8 8 0 1 0 6 14Z" fill="#dcecff"/>'}${cloud}`);
}

elements["weather-icon"].innerHTML = weatherIconSvg(0, true);

function applyServerState(state) {
  serverState = state;
  const selected = state?.selected;
  locationApiUrl = selected ? `${selected.httpUrl}/config/location` : null;
  llmApiUrl = selected ? `${selected.httpUrl}/config/llm` : null;
  homeApiUrl = selected ? `${selected.httpUrl}/home` : null;
  musicApiUrl = selected?.musicApiUrl || null;
  elements["server-summary"].textContent = selected
    ? `${selected.name} · ${selected.address}:${selected.port}`
    : state?.selectionRequired ? "Selecciona un servidor" : "Buscando…";
}

async function loadLocalIdentity() {
  try {
    const response = await fetch(`${serverApiUrl}/identity`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    localSatelliteId = String((await response.json()).satellite?.id || "").trim() || null;
  } catch {
    localSatelliteId = null;
  }
}

function musicRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (localSatelliteId) headers.set("X-Satellite-Id", localSatelliteId);
  return fetch(`${musicApiUrl}${path}`, { ...options, headers });
}

async function homeRequest(path, options = {}) {
  if (!homeApiUrl) throw new Error("Selecciona primero un servidor disponible.");
  const response = await fetch(`${homeApiUrl}${path}`, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
  return result;
}

async function loadHomeDevices({ refresh = false } = {}) {
  try {
    const integration = await homeRequest("/integrations/home-assistant", { cache: "no-store" });
    fillHomeAssistantConfig(integration.config);
    if (!integration.config.enabled) {
      homeState = { floors: [], rooms: [], devices: [], refreshedAt: null, stale: true };
      elements["home-devices-summary"].textContent = "Sin conectar";
      elements["home-devices-list"].replaceChildren();
      elements["home-devices-status"].textContent = "Configura la conexión con Home Assistant en Configuración del servidor.";
      return;
    }
    homeState = await homeRequest(refresh ? "/devices/refresh" : "/devices", { method: refresh ? "POST" : "GET", cache: "no-store" });
    renderHomeCatalog();
    elements["home-devices-status"].textContent = homeState.stale
      ? `Se muestra la última información disponible${homeState.error ? `: ${homeState.error}` : "."}`
      : "Los datos se actualizan automáticamente desde Home Assistant.";
  } catch (error) {
    elements["home-devices-summary"].textContent = "No disponible";
    elements["home-devices-status"].textContent = error.message;
  }
}

function fillHomeAssistantConfig(config) {
  elements["home-assistant-url"].value = config.baseUrl || "http://127.0.0.1:8123";
  elements["home-assistant-token"].value = "";
  homeAssistantCredentialConfigured = config.credential?.configured === true;
  elements["home-assistant-credential-status"].textContent = homeAssistantCredentialConfigured ? "Token configurado; deja el campo vacío para conservarlo" : "Sin token configurado";
  elements["home-assistant-delete-credential"].hidden = !homeAssistantCredentialConfigured;
}

function homeAssistantFormValue() { return { baseUrl: elements["home-assistant-url"].value, token: elements["home-assistant-token"].value }; }

async function testHomeAssistantConnection() {
  elements["home-assistant-test"].disabled = true; elements["home-assistant-status"].textContent = "Probando conexión con Home Assistant…";
  try { await homeRequest("/integrations/home-assistant/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(homeAssistantFormValue()) }); elements["home-assistant-status"].textContent = "Conexión correcta. La configuración todavía no se ha guardado."; }
  catch (error) { elements["home-assistant-status"].textContent = error.message; }
  finally { elements["home-assistant-test"].disabled = false; }
}

async function saveHomeAssistantConnection(event) {
  event.preventDefault();
  const button = elements["home-assistant-form"].querySelector("button[type=submit]"); button.disabled = true; elements["home-assistant-status"].textContent = "Probando y guardando conexión…";
  try { const result = await homeRequest("/integrations/home-assistant", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(homeAssistantFormValue()) }); fillHomeAssistantConfig(result.config); await loadHomeDevices({ refresh: true }); elements["home-assistant-status"].textContent = `Home Assistant conectado. ${homeState.devices.length} dispositivos disponibles.`; }
  catch (error) { elements["home-assistant-status"].textContent = error.message; }
  finally { button.disabled = false; }
}

async function deleteHomeAssistantCredential() {
  try { const result = await homeRequest("/integrations/home-assistant/credential", { method: "DELETE" }); fillHomeAssistantConfig(result.config); homeState = { floors: [], rooms: [], devices: [], refreshedAt: null, stale: true }; renderHomeCatalog(); elements["home-assistant-status"].textContent = "Token de Home Assistant eliminado."; }
  catch (error) { elements["home-assistant-status"].textContent = error.message; }
}

const homeDomainPresentation = {
  light: ["💡", "Luz"], switch: ["⏻", "Interruptor"], sensor: ["◌", "Sensor"],
  binary_sensor: ["◉", "Sensor binario"], climate: ["🌡", "Climatización"], cover: ["▤", "Cortina o persiana"],
  fan: ["🌀", "Ventilador"], lock: ["🔒", "Cerradura"], media_player: ["♫", "Reproductor"], vacuum: ["⌁", "Aspiradora"]
};

function renderHomeCatalog() {
  const devices = [...(homeState.devices || [])].sort((left, right) =>
    [left.floor || "", left.room || "", left.name || ""].join("/").localeCompare(
      [right.floor || "", right.room || "", right.name || ""].join("/"), "es", { sensitivity: "base" }
    ));
  elements["home-devices-summary"].textContent = `${devices.length} dispositivo${devices.length === 1 ? "" : "s"} · ${(homeState.rooms || []).length} habitación${homeState.rooms?.length === 1 ? "" : "es"}`;
  elements["home-devices-list"].replaceChildren(...devices.map((device) => {
    const [icon, typeLabel] = homeDomainPresentation[device.domain] || ["⌂", device.domain || "Dispositivo"];
    const card = document.createElement("article");
    card.className = `destination-card${device.available === false ? " offline" : ""}`;
    const info = document.createElement("span"); info.innerHTML = "<strong></strong><small></small>";
    info.querySelector("strong").textContent = device.name;
    const location = [device.floor, device.room].filter(Boolean);
    const state = device.state == null ? null : `${device.state}${device.unit || ""}`;
    info.querySelector("small").textContent = [...location, typeLabel, state].filter(Boolean).join(" · ");
    card.append(Object.assign(document.createElement("span"), { className: "destination-icon", textContent: icon }), info);
    return card;
  }));
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
          ? "Servidor disponible."
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
    await loadMusicDestinations();
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
  return configured?.name || playback.destination?.name || null;
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
  elements.track.textContent = item?.name || "Sin reproducción";
  elements["playback-artists"].textContent = item?.artists?.join(", ") || "";
  elements["playback-album"].textContent = item?.album || "";
  const sourceName = playback.source?.name || item?.provider || "--";
  const stationName = item?.mediaType === "radio" && item?.name ? ` · Emisora: ${item.name}` : "";
  elements["playback-source"].textContent = `Origen: ${sourceName}${item?.library ? " · Biblioteca" : ""}${stationName}`;
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
    const response = await musicRequest("/music/volume", {
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
    const response = await musicRequest(`/music/${action}`, {
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
    const response = await musicRequest("/music/playback", { cache: "no-store" });
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

function renderLlmFields({ applyDefaults = false } = {}) {
  const provider = elements["llm-provider"].value;
  const external = provider !== "ollama";
  const fixedUrl = ["openai", "github-models"].includes(provider);
  elements["llm-base-url-field"].hidden = fixedUrl;
  elements["llm-api-key-field"].hidden = !external;
  elements["llm-context-field"].hidden = external;
  elements["llm-keep-alive-field"].hidden = external;
  elements["llm-think-field"].hidden = external;
  elements["llm-delete-credential"].hidden = !external || !llmCredentialConfigured;
  elements["llm-credential-status"].textContent = llmCredentialConfigured ? "Credencial configurada; déjalo vacío para conservarla" : "Sin credencial configurada";
  if (applyDefaults) {
    elements["llm-base-url"].value = llmProviderDefaults[provider].baseUrl;
    elements["llm-model"].value = llmProviderDefaults[provider].model;
    elements["llm-api-key"].value = "";
    llmCredentialConfigured = false;
    elements["llm-delete-credential"].hidden = true;
    elements["llm-credential-status"].textContent = external ? "La credencial se guardará únicamente en el servidor" : "";
  }
}

function fillLlmConfig(config) {
  elements["llm-provider"].value = config.provider;
  elements["llm-base-url"].value = config.baseUrl || llmProviderDefaults[config.provider]?.baseUrl || "";
  elements["llm-model"].value = config.model || "";
  elements["llm-temperature"].value = config.temperature ?? 0.1;
  elements["llm-context-length"].value = config.contextLength ?? 8192;
  elements["llm-keep-alive"].value = config.keepAlive || "30m";
  elements["llm-think"].checked = config.think === true;
  elements["llm-api-key"].value = "";
  llmCredentialConfigured = config.credential?.configured === true;
  elements["llm-summary"].textContent = `${elements["llm-provider"].selectedOptions[0].textContent} · ${config.model}`;
  renderLlmFields();
}

async function loadLlmConfig() {
  if (!llmApiUrl) {
    elements["llm-status"].textContent = "Selecciona primero un servidor disponible.";
    return false;
  }
  try {
    const response = await fetch(llmApiUrl, { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    fillLlmConfig(result.config);
    elements["llm-status"].textContent = "";
    return true;
  } catch (error) {
    elements["llm-status"].textContent = "No se pudo cargar la configuración del modelo.";
    return false;
  }
}

function llmFormValue() {
  return {
    provider: elements["llm-provider"].value,
    baseUrl: elements["llm-base-url"].value,
    model: elements["llm-model"].value,
    apiKey: elements["llm-api-key"].value,
    temperature: Number(elements["llm-temperature"].value),
    contextLength: Number(elements["llm-context-length"].value),
    think: elements["llm-think"].checked,
    keepAlive: elements["llm-keep-alive"].value || "30m"
  };
}

async function testLlmConfiguration() {
  elements["llm-test"].disabled = true;
  elements["llm-status"].textContent = "Probando conexión con el modelo…";
  try {
    const response = await fetch(`${llmApiUrl}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(llmFormValue()) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    elements["llm-status"].textContent = "Conexión correcta. La configuración todavía no se ha guardado.";
  } catch (error) {
    elements["llm-status"].textContent = error.message;
  } finally {
    elements["llm-test"].disabled = false;
  }
}

async function saveLlmConfiguration(event) {
  event.preventDefault();
  const button = elements["llm-form"].querySelector("button[type=submit]");
  button.disabled = true;
  elements["llm-status"].textContent = "Probando y guardando configuración…";
  try {
    const response = await fetch(llmApiUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(llmFormValue()) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    fillLlmConfig(result.config);
    elements["llm-status"].textContent = "Proveedor probado, guardado y activado.";
  } catch (error) {
    elements["llm-status"].textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function deleteLlmCredential() {
  if (!confirm("¿Eliminar la credencial guardada para este proveedor?")) return;
  try {
    const response = await fetch(`${llmApiUrl}/credential`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    fillLlmConfig(result.config);
    elements["llm-status"].textContent = "Credencial eliminada.";
  } catch (error) {
    elements["llm-status"].textContent = error.message;
  }
}

async function loadAssistantConfig() {
  try {
    const response = await fetch(assistantApiUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { config } = await response.json();
    elements["assistant-summary"].textContent = `${config.name} · ${config.wakeWordEnabled !== false ? "activación automática" : "sólo botón"}`;
    elements["assistant-name"].value = config.name;
    elements["wake-word-enabled"].checked = config.wakeWordEnabled !== false;
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
      body: JSON.stringify({
        name: elements["assistant-name"].value,
        wakeWordEnabled: elements["wake-word-enabled"].checked
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    elements["assistant-name"].value = result.config.name;
    elements["wake-word-enabled"].checked = result.config.wakeWordEnabled !== false;
    elements["assistant-summary"].textContent = `${result.config.name} · ${result.config.wakeWordEnabled !== false ? "activación automática" : "sólo botón"}`;
    elements["assistant-status"].textContent = result.config.wakeWordEnabled
      ? `Configuración guardada. Di “${result.config.name}” o toca el micrófono.`
      : "Configuración guardada. La escucha continua está apagada; usa el botón de micrófono.";
  } catch (error) {
    elements["assistant-status"].textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function updateMusicSummary() {
  if (!musicState) return;
  const destinations = musicState.destinations || [];
  const activeDestination = destinations.find((item) => item.active || item.id === musicState.activeDestinationId);
  elements["music-destinations-summary"].textContent = activeDestination?.name
    || (destinations.length ? `${destinations.length} disponibles` : "Sin configurar");
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
        const response = await musicRequest("/sources/active", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: source.id }) });
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

function renderMusicDestinations() {
  const destinations = musicState?.destinations || [];
  elements["music-destinations-list"].replaceChildren(...destinations.map((destination) => {
    const button = document.createElement("button");
    const active = destination.active || destination.id === musicState.activeDestinationId;
    button.className = `destination-card${active ? " active selected" : ""}${destination.available ? "" : " offline"}`;
    button.type = "button";
    button.disabled = active || !destination.available;
    button.innerHTML = '<span class="destination-icon">🔊</span><span><strong></strong><small class="destination-meta"></small><small class="destination-route"></small></span><span class="selection-mark"></span>';
    button.querySelector("strong").textContent = destination.name;
    const meta = button.querySelector(".destination-meta");
    const dot = document.createElement("span");
    dot.className = `availability-dot${destination.available ? " online" : ""}`;
    meta.replaceChildren(dot, document.createTextNode(destination.available ? "Disponible" : "Desconectado"));
    button.querySelector(".destination-route").textContent = `${destination.provider || "Music Assistant"}${active ? " · Destino activo" : ""}`;
    button.querySelector(".selection-mark").textContent = active ? "✓" : "";
    button.addEventListener("click", async () => {
      button.disabled = true;
      elements["music-destinations-status"].textContent = "Cambiando destino activo…";
      try {
        const response = await musicRequest("/destinations/active", {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: destination.id })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
        musicState.activeDestinationId = result.id;
        musicState.destinations = musicState.destinations.map((item) => ({ ...item, active: item.id === result.id }));
        elements["music-destinations-status"].textContent = `${result.name} es ahora el destino activo de este satélite`;
        if (result.playback) {
          playbackRequestGeneration += 1;
          renderPlayback({ ...result.playback, destination: result });
        }
        renderMusicDestinations();
      } catch (error) {
        elements["music-destinations-status"].textContent = error.message;
        button.disabled = false;
      }
    });
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
    const response = await musicRequest(`/destinations${discover ? "/discover" : ""}`, { method: discover ? "POST" : "GET" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    musicState = result;
    renderMusicDestinations();
    if (playbackSnapshot) renderPlayback(playbackSnapshot);
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
    const response = await musicRequest("/integration/music-assistant");
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
    const response = await musicRequest("/integration/music-assistant/login", {
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


function updateAudioMeter({ level = 0, db = -60, clipping = false }) {
  const now = performance.now();
  if (level > 0 && now - lastAudioMeterUpdateAt < 100) return;
  lastAudioMeterUpdateAt = now;
  displayedAudioLevel = displayedAudioLevel * 0.35 + level * 0.65;
  if (displayedAudioLevel >= peakAudioLevel || now > peakHoldUntil) {
    peakAudioLevel = displayedAudioLevel;
    peakHoldUntil = now + 550;
  } else {
    peakAudioLevel = Math.max(displayedAudioLevel, peakAudioLevel - 0.025);
  }
  elements["audio-level-bar"].style.width = `${displayedAudioLevel * 100}%`;
  elements["audio-level-peak"].style.left = `${peakAudioLevel * 100}%`;
  elements["audio-level-db"].textContent = `${Math.round(db)} dB`;
  elements["audio-level-bar"].closest(".audio-meter").classList.toggle("clipping", clipping);
}

function setListeningIndicator(active, label = "Te escucho") {
  elements["listening-label"].textContent = label;
  elements["listening-indicator"].classList.toggle("active", active);
  elements["listening-indicator"].setAttribute("aria-hidden", String(!active));
  elements["conversation-panel"].classList.toggle("listening", active);
  elements["manual-listen"].classList.toggle("active", active);
  elements["manual-listen"].setAttribute("aria-pressed", String(active));
}

async function startManualListening() {
  if (manualListenRequestPending) return;
  manualListenRequestPending = true;
  elements["manual-listen"].disabled = true;
  try {
    const response = await fetch(`${serverApiUrl}/voice/listen`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    setListeningIndicator(true, "Te escucho");
    elements.transcript.textContent = "Escuchando…";
  } catch (error) {
    elements.transcript.textContent = error.message;
  } finally {
    manualListenRequestPending = false;
    elements["manual-listen"].disabled = false;
  }
}

function updateClock() {
  const now = new Date();
  elements.clock.textContent = now.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
  elements.date.textContent = now.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" });
}

function showScreen(id) {
  window.virtualKeyboard?.hide();
  document.querySelectorAll(".screen").forEach((screen) => {
    const active = screen.id === id;
    screen.classList.toggle("active", active);
    if (active) screen.scrollTop = 0;
  });
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "No disponible";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** unit)).toLocaleString("es-CL", { maximumFractionDigits: unit > 2 ? 1 : 0 })} ${units[unit]}`;
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return "No disponible";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days ? `${days} d` : null, hours ? `${hours} h` : null, `${minutes} min`].filter(Boolean).join(" ");
}

function systemInfoCard(title, value, detail = "") {
  const card = document.createElement("article");
  card.className = "system-info-card";
  const heading = document.createElement("small"); heading.textContent = title;
  const content = document.createElement("strong"); content.textContent = value;
  card.append(heading, content);
  if (detail) { const description = document.createElement("span"); description.textContent = detail; card.append(description); }
  return card;
}

async function loadSystemInformation() {
  elements["system-info-status"].textContent = "Consultando el satélite…";
  try {
    const response = await fetch(systemApiUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const info = await response.json();
    const memoryPercent = info.memory.total ? (info.memory.used / info.memory.total) * 100 : 0;
    const diskPercent = info.disk?.total ? (info.disk.used / info.disk.total) * 100 : 0;
    const addresses = info.network?.map((item) => `${item.interface}: ${item.address}`).join(" · ") || "Sin dirección IPv4";
    const serverVersion = info.server?.version || (info.server ? "No disponible" : "Sin servidor seleccionado");
    const serverDetail = info.server?.name
      ? `${info.server.name}${info.server.available === false ? " · desconectado" : ""}`
      : "";
    elements["system-info-grid"].replaceChildren(
      systemInfoCard("Versión del satélite", info.version || "Desconocida"),
      systemInfoCard("Versión del servidor", serverVersion, serverDetail),
      systemInfoCard("Equipo", info.hostname, `${info.architecture} · Node ${info.nodeVersion}`),
      systemInfoCard("Sistema operativo", info.operatingSystem, info.kernel),
      systemInfoCard("CPU", `${info.cpu.usagePercent.toLocaleString("es-CL", { maximumFractionDigits: 1 })}% en uso`, `${info.cpu.cores} núcleos · ${info.cpu.model}`),
      systemInfoCard("Temperatura CPU", info.cpu.temperatureCelsius === null ? "No disponible" : `${info.cpu.temperatureCelsius.toLocaleString("es-CL", { maximumFractionDigits: 1 })} °C`, `Carga: ${info.cpu.loadAverage.map((value) => value.toFixed(2)).join(" · ")}`),
      systemInfoCard("Memoria", `${formatBytes(info.memory.available)} disponibles`, `${formatBytes(info.memory.used)} usados de ${formatBytes(info.memory.total)} · ${memoryPercent.toFixed(0)}%`),
      systemInfoCard("Almacenamiento /", info.disk ? `${formatBytes(info.disk.available)} disponibles` : "No disponible", info.disk ? `${formatBytes(info.disk.used)} usados de ${formatBytes(info.disk.total)} · ${diskPercent.toFixed(0)}%` : ""),
      systemInfoCard("Tiempo encendido", formatUptime(info.uptimeSeconds)),
      systemInfoCard("Red", addresses)
    );
    elements["system-info-summary"].textContent = `${info.hostname} · Satélite ${info.version || "?"} · Servidor ${info.server?.version || "?"}`;
    elements["system-info-status"].textContent = `Actualizado a las ${new Date().toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  } catch {
    elements["system-info-status"].textContent = "No se pudo obtener la información del satélite.";
    elements["system-info-summary"].textContent = "No disponible";
  }
}

function enableConfigurationDragScrolling() {
  const editControlSelector = "input, select, textarea, [contenteditable='true']";
  document.querySelectorAll(".screen:not(#home-screen)").forEach((screen) => {
    let drag = null;
    let inertiaFrame = null;
    let suppressClicksUntil = 0;

    const stopInertia = () => {
      if (inertiaFrame !== null) cancelAnimationFrame(inertiaFrame);
      inertiaFrame = null;
    };

    screen.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0 || event.target.closest(editControlSelector)) return;
      stopInertia();
      drag = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY, lastTime: performance.now(), velocity: 0, moved: false };
    });

    screen.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const now = performance.now();
      const delta = drag.lastY - event.clientY;
      const elapsed = Math.max(1, now - drag.lastTime);
      if (Math.abs(drag.startY - event.clientY) > 10) {
        drag.moved = true;
        if (!screen.hasPointerCapture(event.pointerId)) screen.setPointerCapture(event.pointerId);
      }
      if (drag.moved) {
        screen.classList.add("drag-scrolling");
        screen.scrollTop += delta;
        drag.velocity = drag.velocity * 0.65 + (delta / elapsed) * 0.35;
        drag.lastY = event.clientY;
        drag.lastTime = now;
        event.preventDefault();
      }
    });

    const finishDrag = (event, useInertia) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const velocity = drag.velocity;
      const moved = drag.moved;
      if (moved) suppressClicksUntil = performance.now() + 500;
      drag = null;
      screen.classList.remove("drag-scrolling");
      if (screen.hasPointerCapture(event.pointerId)) screen.releasePointerCapture(event.pointerId);
      if (!useInertia || !moved || Math.abs(velocity) < 0.02) return;
      let speed = velocity;
      let previous = performance.now();
      const glide = (now) => {
        const before = screen.scrollTop;
        screen.scrollTop += speed * Math.min(32, now - previous);
        previous = now;
        speed *= 0.92;
        if (Math.abs(speed) >= 0.02 && screen.scrollTop !== before) inertiaFrame = requestAnimationFrame(glide);
        else inertiaFrame = null;
      };
      inertiaFrame = requestAnimationFrame(glide);
    };

    screen.addEventListener("pointerup", (event) => finishDrag(event, true));
    screen.addEventListener("pointercancel", (event) => finishDrag(event, false));
    screen.addEventListener("click", (event) => {
      if (performance.now() >= suppressClicksUntil) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    screen.addEventListener("wheel", stopInertia, { passive: true });
  });
}

function deviceName(kind, id) {
  return audioState?.devices[kind].find((device) => device.id === id)?.name || (id ? "Dispositivo no disponible" : (kind === "input" ? "Entrada predeterminada" : "Salida predeterminada"));
}

function updateAudioSummaries() {
  if (!audioState) return;
  const effective = audioState.effectiveConfig || audioState.config;
  const channel = Number.isInteger(effective.inputChannel) ? ` · Canal ${effective.inputChannel + 1}` : "";
  const inputFallback = effective.inputDeviceId !== (audioState.config.inputDeviceIds[0] || null) ? " · fallback" : "";
  const outputFallback = effective.outputDeviceId !== (audioState.config.outputDeviceIds[0] || null) ? " · fallback" : "";
  elements["input-summary"].textContent = `${deviceName("input", effective.inputDeviceId)}${channel}${inputFallback}`;
  elements["output-summary"].textContent = `${deviceName("output", effective.outputDeviceId)}${outputFallback}`;
  const voice = audioState.voices?.find((item) => item.id === audioState.config.ttsVoiceId) || audioState.voices?.[0];
  elements["voice-summary"].textContent = voice?.name || "Sin voces disponibles";
  const player = audioState.musicPlayer;
  elements["music-player-summary"].textContent = player?.enabled ? (player.running ? "Activo" : "No iniciado") : "Deshabilitado";
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
  elements["music-player-output"].value = audioState.config.musicOutputDeviceId || "";
  renderMusicPlayerOutputs();
  elements["music-player-enabled"].checked = audioState.config.musicPlayerEnabled !== false;
  const playerStatus = audioState.musicPlayer?.running
    ? "Sendspin está activo y disponible para Music Assistant."
    : (audioState.config.musicPlayerEnabled === false ? "El reproductor está deshabilitado." : (audioState.musicPlayer?.error || "Sendspin no está activo. Comprueba que esté instalado en el satélite."));
  elements["music-player-status"].textContent = playerStatus;
}

function renderMusicPlayerOutputs() {
  const configured = elements["music-player-output"].value.trim();
  const selected = /^(?:null|undefined|none|\(null\)|<null>)$/i.test(configured) ? "" : configured;
  if (!selected && configured) elements["music-player-output"].value = "";
  const outputs = [
    { id: "", name: "Salida predeterminada", description: "Sendspin utilizará la salida predeterminada del sistema" },
    ...(audioState?.devices.output || []).map((device) => ({ id: device.id, name: device.name || device.id, description: `${device.available === false ? "No disponible" : "Disponible"} · ${device.id}`, available: device.available !== false }))
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
  const selectedId = audioState.config[listKey]?.[0] || null;
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
    const selectedDeviceId = audioState.config.inputDeviceIds?.[0];
    const selected = channel.id === audioState.config.inputChannelsByDevice?.[selectedDeviceId];
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

function connectLocalEvents() {
  clearTimeout(localEventsReconnectTimer);
  localEventsReconnectTimer = null;
  if (localEventsSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(localEventsSocket.readyState)) return;
  const socket = new WebSocket(localEventsUrl);
  localEventsSocket = socket;
  socket.addEventListener("message", ({ data }) => {
    try {
      const event = JSON.parse(data);
      if (event.protocolVersion !== "2") return;
      if (event.type === "audio.level.updated") updateAudioMeter(event.payload);
      if (event.type === "voice.wake-word.detected") {
        setListeningIndicator(true, event.payload.manual ? "Te escucho" : "Te escucho");
        elements.transcript.textContent = "Escuchando…";
      }
      if (event.type === "voice.listening.ended") setListeningIndicator(false);
    } catch { /* un evento local inválido no debe afectar el display */ }
  });
  socket.addEventListener("close", () => {
    if (localEventsSocket === socket) localEventsSocket = null;
    updateAudioMeter({});
    localEventsReconnectTimer = setTimeout(connectLocalEvents, 2000);
  });
  socket.addEventListener("error", () => socket.close());
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
    listeningGeneration += 1;
    setListeningIndicator(false);
    elements.connection.className = "badge text-bg-danger";
    elements.connection.textContent = "Desconectado";
    displayReconnectTimer = setTimeout(() => { displayReconnectTimer = null; connect(generation); }, 3000);
  });
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.protocolVersion !== "2") {
      elements.connection.className = "badge text-bg-danger";
      elements.connection.textContent = "Servidor incompatible";
      socket.close();
      return;
    }
    const isLocalSatelliteEvent = Boolean(localSatelliteId) && event.source === localSatelliteId;
    const isLocalAssistantEvent = Boolean(localSatelliteId) && event.payload?.targetSatelliteId === localSatelliteId;
    if (["voice.transcript.received", "voice.wake-word.detected", "voice.listening.ended", "voice.follow-up-listening.started"].includes(event.type) && !isLocalSatelliteEvent) return;
    if (["assistant.processing.started", "assistant.response.created"].includes(event.type) && !isLocalAssistantEvent) return;
    if (event.type === "voice.transcript.received") {
      listeningGeneration += 1;
      setListeningIndicator(false);
      elements.transcript.textContent = event.payload.text;
    }
    if (event.type === "voice.wake-word.detected") {
      listeningGeneration += 1;
      setListeningIndicator(true, "Te escucho");
      elements.transcript.textContent = "Escuchando…";
    }
    if (event.type === "voice.listening.ended") {
      const generation = ++listeningGeneration;
      setListeningIndicator(false);
      elements.transcript.textContent = event.payload.reason === "captured"
        ? "Procesando tu solicitud…"
        : event.payload.reason === "timeout"
          ? "No escuché ningún comando."
          : event.payload.reason === "interrupted_by_speech" ? "Esperando voz…" : "No pude entenderte.";
      setTimeout(() => {
        if (listeningGeneration === generation) elements.transcript.textContent = "Esperando voz…";
      }, 2500);
    }
    if (event.type === "voice.follow-up-listening.started") {
      listeningGeneration += 1;
      setListeningIndicator(true, "Puedes responder");
      elements.transcript.textContent = "Puedes responder…";
    }
    if (event.type === "assistant.processing.started") {
      setListeningIndicator(false);
      elements.response.textContent = event.payload.text;
      elements.response.classList.add("processing");
    }
    if (event.type === "assistant.response.created") {
      elements.response.textContent = event.payload.text;
      elements.response.classList.remove("processing");
    }
    if (event.type === "weather.updated") {
      elements.weather.textContent = `${Math.round(event.payload.temperature)}°`;
      elements["weather-icon"].innerHTML = weatherIconSvg(event.payload.weatherCode, event.payload.isDay !== false);
      elements["weather-icon"].setAttribute("aria-label", event.payload.condition || "Estado del clima");
      elements["weather-condition"].textContent = `${event.payload.condition} · Sensación ${Math.round(event.payload.apparentTemperature)}°`;
      elements["moon-icon"].textContent = event.payload.moonPhase?.icon || "🌑";
      elements["moon-icon"].setAttribute("aria-label", event.payload.moonPhase?.name || "Fase lunar");
      elements["moon-phase-name"].textContent = event.payload.moonPhase?.name || "Fase lunar";
    }
    if (event.type === "music.playback.changed") {
      const activeDestinationId = musicState?.activeDestinationId;
      if (activeDestinationId && event.payload.destination?.id === activeDestinationId) {
        playbackRequestGeneration += 1;
        renderPlayback(event.payload);
      }
    }
  });
}

document.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", async () => {
  showScreen(button.dataset.screen);
  if (button.dataset.screen === "settings-screen") {
    await loadServers();
    await Promise.all([loadAudio(), loadAssistantConfig(), loadMusicDestinations(), loadHomeDevices(), loadSystemInformation()]);
  }
  if (button.dataset.screen === "server-settings-screen") {
    await loadServers();
    await Promise.all([loadLocation(), loadLlmConfig(), loadMusicAssistantStatus()]);
  }
  if (button.dataset.screen === "server-screen") await loadServers();
  if (button.dataset.screen === "assistant-screen") await loadAssistantConfig();
  if (button.dataset.screen === "voice-screen") await openVoices();
  if (button.dataset.screen === "location-screen") await loadLocation();
  if (button.dataset.screen === "llm-screen") await loadLlmConfig();
  if (button.dataset.screen === "music-destinations-screen") await loadMusicDestinations();
  if (button.dataset.screen === "music-sources-screen") await loadMusicDestinations();
  if (button.dataset.screen === "music-assistant-screen") await loadMusicAssistantStatus();
  if (button.dataset.screen === "music-player-screen") { await loadAudio(); fillMusicPlayer(); }
  if (button.dataset.screen === "home-devices-screen") await loadHomeDevices();
  if (button.dataset.screen === "home-assistant-screen") await loadHomeDevices();
  if (button.dataset.screen === "system-info-screen") await loadSystemInformation();
}));
elements["refresh-system-info"].addEventListener("click", loadSystemInformation);
document.querySelectorAll("[data-audio-kind]").forEach((button) => button.addEventListener("click", () => openAudio(button.dataset.audioKind)));
elements["assistant-form"].addEventListener("submit", saveAssistantName);
elements["manual-listen"].addEventListener("click", startManualListening);
elements["location-form"].addEventListener("submit", saveLocation);
elements["detect-location"].addEventListener("click", detectLocation);
elements["llm-provider"].addEventListener("change", () => renderLlmFields({ applyDefaults: true }));
elements["llm-form"].addEventListener("submit", saveLlmConfiguration);
elements["llm-test"].addEventListener("click", testLlmConfiguration);
elements["llm-delete-credential"].addEventListener("click", deleteLlmCredential);
elements["home-assistant-form"].addEventListener("submit", saveHomeAssistantConnection);
elements["home-assistant-test"].addEventListener("click", testHomeAssistantConnection);
elements["home-assistant-delete-credential"].addEventListener("click", deleteHomeAssistantCredential);
elements["discover-music-destinations"].addEventListener("click", () => loadMusicDestinations({ discover: true }));
elements["discover-servers"].addEventListener("click", async () => {
  elements["discover-servers"].disabled = true;
  await loadServers({ refresh: true });
  elements["discover-servers"].disabled = false;
});
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

enableConfigurationDragScrolling();
updateClock();
setInterval(updateClock, 1000);
elements["playback-cover"].addEventListener("error", () => {
  elements["playback-cover"].classList.remove("visible");
  elements["playback-cover-placeholder"].classList.remove("hidden");
});
connectLocalEvents();
void (async () => {
  await Promise.all([loadLocalIdentity(), loadServers()]);
  await loadMusicDestinations();
  await loadCurrentPlayback();
  connect();
})();
setInterval(() => { if (!document.hidden) void loadCurrentPlayback(); }, 2_000);
setInterval(() => { if (musicApiUrl) void loadMusicAssistantStatus(); }, 30_000);
setInterval(updatePlaybackProgress, 1000);
