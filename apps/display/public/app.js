import { BrowserAudioController } from "./audio/browser-audio-controller.js";
import { createBrowserSatelliteId } from "./browser-identity.js";
import { resolveMusicArtworkUrl } from "./music-artwork.js";

const elements = Object.fromEntries([
  "clock", "date", "connection", "weather", "weather-icon", "weather-condition", "moon-phase", "moon-icon", "moon-phase-name", "track", "device", "transcript", "response",
  "playback-cover", "playback-cover-placeholder", "playback-artists", "playback-album", "playback-progress-bar", "playback-time",
  "playback-volume", "playback-volume-value", "playback-previous", "playback-toggle", "playback-next", "playback-controls-status",
  "input-summary", "output-summary", "audio-title", "audio-help", "audio-status", "device-list",
  "channel-status", "channel-list", "audio-level-db", "audio-level-bar", "audio-level-peak", "conversation-panel", "listening-indicator", "listening-label",
  "assistant-summary", "assistant-form", "assistant-name", "assistant-status", "connected-power-device", "connected-power-device-open", "connected-power-device-label",
  "wake-word-enabled", "manual-listen"
  , "voice-summary", "voice-status", "voice-list", "voice-preview"
  , "location-summary", "location-form", "location-city", "location-region", "location-country",
  "location-latitude", "location-longitude", "location-time-zone", "location-status", "detect-location"
  , "llm-summary", "llm-form", "llm-provider", "llm-provider-open", "llm-provider-label", "llm-base-url-field", "llm-base-url", "llm-model",
  "llm-api-key-field", "llm-api-key", "llm-credential-status", "llm-temperature", "llm-context-field",
  "llm-context-length", "llm-keep-alive-field", "llm-keep-alive", "llm-think-field", "llm-think",
  "llm-test", "llm-delete-credential", "llm-status"
  , "music-destinations-summary", "music-destinations-status", "music-destinations-list", "discover-music-destinations"
  , "music-sources-menu-summary", "music-sources-summary", "music-sources-status", "music-sources-list"
  , "music-assistant-summary", "music-assistant-form", "music-assistant-username", "music-assistant-password", "music-assistant-status"
  , "server-summary"
  , "home-devices-summary", "home-devices-status", "home-devices-list"
  , "home-assistant-form", "home-assistant-url", "home-assistant-token", "home-assistant-credential-status",
  "home-assistant-test", "home-assistant-delete-credential", "home-assistant-status",
  "home-automation-setting", "system-info-summary", "system-info-status", "system-info-grid", "refresh-system-info",
  "selection-back", "selection-title", "selection-help", "selection-list"
].map((id) => [id, document.getElementById(id)]));

const playbackSource = document.createElement("div");
playbackSource.id = "playback-source";
playbackSource.className = "playback-device";
playbackSource.textContent = "Origen: --";
elements["playback-album"].after(playbackSource);
elements["playback-source"] = playbackSource;
const serverApiUrl = location.origin;
const browserAudio = new BrowserAudioController();
const SATELLITE_ID_STORAGE_KEY = "ha.browser-satellite.id.v1";
const ASSISTANT_STORAGE_KEY = "ha.browser-satellite.assistant.v1";
let locationApiUrl = null;
let llmApiUrl = null;
let homeApiUrl = null;
let musicApiUrl = null;
let voiceApiUrl = null;
let localSatelliteId = null;
let serverState = null;
let displaySocket = null;
let displaySocketGeneration = 0;
let displayReconnectTimer = null;
let audioState = null;
let voiceState = null;
let musicState = null;
let activeAudioKind = "input";
let displayedAudioLevel = 0;
let peakAudioLevel = 0;
let peakHoldUntil = 0;
let lastAudioMeterUpdateAt = 0;
let playbackSnapshot = null;
let playbackReceivedAt = 0;
let playbackVolumeEditing = false;
let playbackVolumeCommitTimer = null;
let lastNonEmptyPlaybackAt = 0;
let playbackRequestGeneration = 0;
let llmCredentialConfigured = false;
let homeState = { floors: [], rooms: [], devices: [], refreshedAt: null, stale: true };
let homeAssistantCredentialConfigured = false;
let manualListenRequestPending = false;
let connectedPowerOptions = [{ id: "", name: "Ninguno", description: "Sin enchufe asociado" }];
let selectionReturnScreen = "settings-screen";
let browserAudioStarting = null;

function normalizeDirectServerUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("La URL debe comenzar con http:// o https://");
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function directServer(urlValue) {
  const httpUrl = normalizeDirectServerUrl(urlValue);
  const url = new URL(httpUrl);
  const secure = url.protocol === "https:";
  return {
    id: httpUrl,
    name: url.hostname,
    address: url.hostname,
    port: Number(url.port || (secure ? 443 : 80)),
    protocolVersion: "5",
    httpUrl,
    webSocketUrl: `${secure ? "wss:" : "ws:"}//${url.host}/ws`,
    musicApiUrl: `${httpUrl}/music-gateway/v1`
  };
}

function storedAssistantConfig() {
  try {
    return {
      name: "Asistente",
      wakeWordEnabled: true,
      connectedPowerDeviceId: null,
      ...JSON.parse(localStorage.getItem(ASSISTANT_STORAGE_KEY) || "{}")
    };
  } catch {
    return { name: "Asistente", wakeWordEnabled: true, connectedPowerDeviceId: null };
  }
}

function wakeWordPayload(config = storedAssistantConfig()) {
  return {
    enabled: config.wakeWordEnabled === true,
    provider: "stt",
    modelId: null,
    wakeWord: config.name,
    connectedPowerDeviceId: config.connectedPowerDeviceId || null
  };
}

const llmProviderDefaults = {
  ollama: { baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:9b" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  "github-models": { baseUrl: "https://models.github.ai/inference", model: "openai/gpt-4.1" },
  "openai-compatible": { baseUrl: "", model: "" }
};
const llmProviderOptions = [
  { id: "ollama", name: "Ollama", description: "Modelo local o servidor Ollama" },
  { id: "openai", name: "OpenAI API", description: "API oficial de OpenAI" },
  { id: "github-models", name: "GitHub Models", description: "Modelos disponibles mediante GitHub" },
  { id: "openai-compatible", name: "API compatible con OpenAI", description: "Proveedor externo con API compatible" }
];

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

function applyServerState(server) {
  serverState = server;
  locationApiUrl = server ? `${server.httpUrl}/config/location` : null;
  llmApiUrl = server ? `${server.httpUrl}/config/llm` : null;
  homeApiUrl = server ? `${server.httpUrl}/home` : null;
  musicApiUrl = server?.musicApiUrl || null;
  voiceApiUrl = server ? `${server.httpUrl}/tts` : null;
  elements["server-summary"].textContent = server
    ? `${server.name} · ${server.address}:${server.port}`
    : "Servidor no disponible";
}

async function loadLocalIdentity() {
  const stored = localStorage.getItem(SATELLITE_ID_STORAGE_KEY);
  if (stored) {
    localSatelliteId = stored;
    return;
  }
  localSatelliteId = createBrowserSatelliteId();
  localStorage.setItem(SATELLITE_ID_STORAGE_KEY, localSatelliteId);
}

function musicRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (localSatelliteId) headers.set("X-Satellite-Id", localSatelliteId);
  return fetch(`${musicApiUrl}${path}`, { ...options, headers });
}

async function homeRequest(path, options = {}) {
  if (!homeApiUrl) throw new Error("El servidor no está disponible.");
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

async function loadServer() {
  try {
    const response = await fetch(`${serverApiUrl}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1_500)
    });
    const health = await response.json();
    if (!response.ok) throw new Error(health.message || `HTTP ${response.status}`);
    if (health.protocolVersion !== "5") throw new Error(`Protocolo ${health.protocolVersion || "desconocido"} incompatible`);
    const server = {
      ...directServer(serverApiUrl),
      id: health.server?.id || serverApiUrl,
      name: health.server?.name || location.hostname
    };
    applyServerState(server);
    return server;
  } catch {
    applyServerState(null);
    return null;
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
  const artworkUrl = resolveMusicArtworkUrl(artworkPath, musicApiUrl);
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
  clearTimeout(playbackVolumeCommitTimer);
  playbackVolumeCommitTimer = null;
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

function schedulePlaybackVolumeCommit(delayMs = 0) {
  clearTimeout(playbackVolumeCommitTimer);
  playbackVolumeCommitTimer = setTimeout(() => {
    playbackVolumeCommitTimer = null;
    void setPlaybackVolume();
  }, delayMs);
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
    elements["location-status"].textContent = "El servidor no está disponible.";
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
  elements["llm-provider-label"].textContent = llmProviderOptions.find((option) => option.id === config.provider)?.name || config.provider;
  elements["llm-base-url"].value = config.baseUrl || llmProviderDefaults[config.provider]?.baseUrl || "";
  elements["llm-model"].value = config.model || "";
  elements["llm-temperature"].value = config.temperature ?? 0.1;
  elements["llm-context-length"].value = config.contextLength ?? 8192;
  elements["llm-keep-alive"].value = config.keepAlive || "30m";
  elements["llm-think"].checked = config.think === true;
  elements["llm-api-key"].value = "";
  llmCredentialConfigured = config.credential?.configured === true;
  elements["llm-summary"].textContent = `${elements["llm-provider-label"].textContent} · ${config.model}`;
  renderLlmFields();
}

async function loadLlmConfig() {
  if (!llmApiUrl) {
    elements["llm-status"].textContent = "El servidor no está disponible.";
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

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString("es-CL", { dateStyle: "medium", timeStyle: "short" }) : "fecha desconocida";
}

async function loadAssistantConfig() {
  const localConfig = storedAssistantConfig();
  elements["assistant-summary"].textContent = `${localConfig.name} · ${localConfig.wakeWordEnabled !== false ? "detección central" : "sólo botón"}`;
  elements["assistant-name"].value = localConfig.name;
  elements["wake-word-enabled"].checked = localConfig.wakeWordEnabled !== false;
  await loadConnectedPowerDevices(localConfig.connectedPowerDeviceId);
  elements["assistant-status"].textContent = "";
  return true;
}

async function loadConnectedPowerDevices(selectedId = null) {
  try {
    const catalog = await homeRequest("/devices", { cache: "no-store" });
    const switches = (catalog.devices || [])
      .filter((device) => device.domain === "switch" && device.enabled !== false)
      .sort((left, right) => [left.room || "", left.name || ""].join("/").localeCompare(
        [right.room || "", right.name || ""].join("/"), "es", { sensitivity: "base" }
      ));
    connectedPowerOptions = [
      { id: "", name: "Ninguno", description: "Sin enchufe asociado" },
      ...switches.map((device) => ({
        id: device.entityId || device.id,
        name: device.name,
        description: device.room || "Sin habitación"
      }))
    ];
    if (selectedId && !switches.some((device) => (device.entityId || device.id) === selectedId)) {
      connectedPowerOptions.push({ id: selectedId, name: selectedId, description: "No disponible" });
    }
  } catch {
    connectedPowerOptions = [{ id: "", name: "Ninguno", description: "Sin enchufe asociado" }];
    if (selectedId) connectedPowerOptions.push({ id: selectedId, name: selectedId, description: "No disponible" });
  }
  elements["connected-power-device"].value = selectedId || "";
  renderConnectedPowerDeviceLabel();
}

async function saveAssistantName(event) {
  event.preventDefault();
  const button = elements["assistant-form"].querySelector("button[type=submit]");
  button.disabled = true;
  elements["assistant-status"].textContent = "Guardando la asignación central…";
  try {
    const config = {
      name: elements["assistant-name"].value.trim(),
      wakeWordEnabled: elements["wake-word-enabled"].checked,
      connectedPowerDeviceId: elements["connected-power-device"].value || null
    };
    if (config.name.length < 2 || config.name.length > 40) throw new Error("El nombre debe tener entre 2 y 40 caracteres.");
    localStorage.setItem(ASSISTANT_STORAGE_KEY, JSON.stringify(config));
    browserAudio.configureWakeWord(wakeWordPayload(config));
    elements["assistant-name"].value = config.name;
    elements["wake-word-enabled"].checked = config.wakeWordEnabled !== false;
    elements["connected-power-device"].value = config.connectedPowerDeviceId || "";
    renderConnectedPowerDeviceLabel();
    elements["assistant-summary"].textContent = `${config.name} · ${config.wakeWordEnabled !== false ? "detección central" : "sólo botón"}`;
    elements["assistant-status"].textContent = config.wakeWordEnabled
      ? `Configuración guardada. Di “${config.name}” o toca el micrófono.`
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
    || (destinations.length ? "Sin destino activo" : "Sin configurar");
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
        const response = await musicRequest("/sources/active", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: source.id }) });
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
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: destination.id })
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
    elements["music-destinations-status"].textContent = "El servidor no está disponible.";
    elements["music-sources-status"].textContent = "El servidor no está disponible.";
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
    elements["music-assistant-summary"].textContent = "Servidor no disponible";
    elements["music-assistant-status"].textContent = "El servidor no está disponible.";
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

function setMicrophoneMeterVisible(visible) {
  const meter = elements["audio-level-bar"].closest(".audio-meter");
  meter.hidden = !visible;
  meter.setAttribute("aria-hidden", String(!visible));
  elements["manual-listen"].hidden = !visible;
  elements["manual-listen"].setAttribute("aria-hidden", String(!visible));
  if (!visible) updateAudioMeter({});
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
    await browserAudio.resume();
    browserAudio.sendEvent("voice.listen.requested", {
      manual: true,
      reason: "manual_request",
      timeoutMs: 7_000
    });
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

function openSelectionScreen({ title, help, returnScreen, options, selectedId, onSelect }) {
  selectionReturnScreen = returnScreen;
  elements["selection-title"].textContent = title;
  elements["selection-help"].textContent = help;
  elements["selection-list"].replaceChildren(...options.map((option) => {
    const selected = option.id === selectedId;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `device-option${selected ? " selected" : ""}`;
    button.innerHTML = `<span><strong></strong><small></small></span><span class="selection-mark">${selected ? "✓" : ""}</span>`;
    button.querySelector("strong").textContent = option.name;
    button.querySelector("small").textContent = option.description || "";
    button.addEventListener("click", () => {
      onSelect(option);
      showScreen(returnScreen);
    });
    return button;
  }));
  showScreen("selection-screen");
}

function renderConnectedPowerDeviceLabel() {
  const selectedId = elements["connected-power-device"].value;
  const selected = connectedPowerOptions.find((option) => option.id === selectedId);
  elements["connected-power-device-label"].textContent = selected?.name || selectedId || "Ninguno";
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
  elements["system-info-status"].textContent = "Consultando Chromium…";
  const audio = browserAudio.snapshot();
  const selected = serverState;
  const platform = navigator.userAgentData?.platform || navigator.platform || "Plataforma desconocida";
  const browser = navigator.userAgentData?.brands?.map((item) => `${item.brand} ${item.version}`).join(" · ") || navigator.userAgent;
  elements["system-info-grid"].replaceChildren(
    systemInfoCard("Identidad del satélite", localSatelliteId || "No asignada"),
    systemInfoCard("Servidor", selected?.name || "Sin seleccionar", selected?.httpUrl || ""),
    systemInfoCard("Plataforma", platform, browser),
    systemInfoCard("CPU disponible", `${navigator.hardwareConcurrency || "?"} núcleos lógicos`),
    systemInfoCard("Memoria declarada", navigator.deviceMemory ? `${navigator.deviceMemory} GB` : "No expuesta por Chromium"),
    systemInfoCard("Pantalla", `${screen.width} × ${screen.height}`, `${devicePixelRatio}× densidad`),
    systemInfoCard("Contexto seguro", window.isSecureContext ? "Sí" : "No", window.isSecureContext ? "Micrófono habilitable" : "Usa localhost o HTTPS para capturar audio"),
    systemInfoCard("Captura", audio.started ? `${audio.captureSampleRate} Hz` : "No iniciada", audio.trackSettings?.deviceId ? "Dispositivo configurado" : "Entrada predeterminada"),
    systemInfoCard("Procesamiento de voz", audio.trackSettings
      ? `Ruido ${audio.trackSettings.noiseSuppression === false ? "off" : "on"} · Eco ${audio.trackSettings.echoCancellation === false ? "off" : "on"}`
      : "Sin datos", `Ganancia automática ${audio.trackSettings?.autoGainControl === true ? "on" : "off"}`),
    systemInfoCard("Reproducción", audio.started ? `${audio.playbackSampleRate} Hz` : "No iniciada", globalThis.AudioContext && typeof AudioContext.prototype.setSinkId === "function" ? "Selección de salida disponible" : "Salida predeterminada de Chromium")
  );
  elements["system-info-summary"].textContent = `${platform} · Chromium web-only`;
  elements["system-info-status"].textContent = `Actualizado a las ${new Date().toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
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

function enableTouchButtonActivation() {
  let press = null;
  let suppressTrustedClicksUntil = 0;

  document.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("button");
    press = event.isPrimary && event.button === 0 && button && !button.disabled
      ? { button, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
      : null;
  }, true);

  document.addEventListener("pointermove", (event) => {
    if (!press || event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) press.moved = true;
  }, true);

  document.addEventListener("pointerup", (event) => {
    if (!press || event.pointerId !== press.pointerId) return;
    const { button, moved } = press;
    press = null;
    if (moved || event.target.closest("button") !== button || button.disabled) return;
    suppressTrustedClicksUntil = performance.now() + 1500;
    event.preventDefault();
    button.click();
  }, true);

  document.addEventListener("pointercancel", () => { press = null; }, true);
  document.addEventListener("click", (event) => {
    if (!event.isTrusted || performance.now() >= suppressTrustedClicksUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
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
}

async function loadAudio() {
  elements["audio-status"].textContent = "Buscando dispositivos…";
  try {
    const devices = await browserAudio.devices({ requestPermission: true });
    const config = browserAudio.config;
    audioState = {
      config: {
        inputDeviceIds: config.inputDeviceId ? [config.inputDeviceId] : [],
        outputDeviceIds: config.outputDeviceId ? [config.outputDeviceId] : [],
        inputChannelsByDevice: config.inputDeviceId ? { [config.inputDeviceId]: config.inputChannel || 0 } : {}
      },
      effectiveConfig: {
        inputDeviceId: config.inputDeviceId,
        outputDeviceId: config.outputDeviceId,
        inputChannel: config.inputChannel || 0
      },
      devices,
      provider: "Chromium"
    };
    elements["audio-status"].textContent = "";
    updateAudioSummaries();
    return true;
  } catch (error) {
    elements["audio-status"].textContent = `No se pudieron consultar los dispositivos de Chromium: ${error.message}`;
    return false;
  }
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
  const browserUpdate = {};
  if ("inputDeviceId" in update) browserUpdate.inputDeviceId = update.inputDeviceId;
  if ("outputDeviceId" in update) browserUpdate.outputDeviceId = update.outputDeviceId;
  if ("inputChannel" in update) browserUpdate.inputChannel = update.inputChannel;
  if (!Object.keys(browserUpdate).length) throw new Error("Esta configuración pertenece al reproductor Sendspin externo.");
  await browserAudio.configure(browserUpdate);
  if ("inputDeviceId" in browserUpdate) {
    audioState.config.inputDeviceIds = browserUpdate.inputDeviceId ? [browserUpdate.inputDeviceId] : [];
    audioState.effectiveConfig.inputDeviceId = browserUpdate.inputDeviceId;
  }
  if ("outputDeviceId" in browserUpdate) {
    audioState.config.outputDeviceIds = browserUpdate.outputDeviceId ? [browserUpdate.outputDeviceId] : [];
    audioState.effectiveConfig.outputDeviceId = browserUpdate.outputDeviceId;
  }
  if ("inputChannel" in browserUpdate) {
    const selected = audioState.config.inputDeviceIds[0];
    if (selected) audioState.config.inputChannelsByDevice[selected] = browserUpdate.inputChannel;
    audioState.effectiveConfig.inputChannel = browserUpdate.inputChannel;
  }
  updateAudioSummaries();
  await startBrowserAudio();
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
    const channels = await browserAudio.inputChannels(deviceId);
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
  const voices = voiceState?.voices || [];
  elements["voice-list"].replaceChildren(...voices.map((voice) => {
    const selected = voice.id === voiceState.selectedVoiceId;
    const button = document.createElement("button");
    button.className = `device-option${selected ? " selected" : ""}`;
    button.innerHTML = `<span><strong></strong><small></small></span><span class="selection-mark">${selected ? "✓" : ""}</span>`;
    button.querySelector("strong").textContent = voice.name;
    button.querySelector("small").textContent = voice.language ? `Idioma: ${voice.language}` : "Voz local";
    button.addEventListener("click", async () => {
      document.querySelectorAll("#voice-list .device-option").forEach((option) => { option.disabled = true; });
      try {
        const response = await fetch(`${voiceApiUrl}/satellites/${encodeURIComponent(localSatelliteId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceId: voice.id })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
        voiceState = result;
        elements["voice-summary"].textContent = voiceState.voices.find((item) => item.id === voiceState.selectedVoiceId)?.name || "Sin voces disponibles";
        elements["voice-status"].textContent = "Voz guardada";
        renderVoices();
      } catch (error) {
        elements["voice-status"].textContent = "No se pudo guardar la voz.";
        renderVoices();
      }
    });
    return button;
  }));
  if (!voices.length) elements["voice-status"].textContent = "El servidor no tiene voces disponibles.";
}

async function loadVoiceConfig({ quiet = false } = {}) {
  if (!voiceApiUrl || !localSatelliteId) {
    if (!quiet) elements["voice-status"].textContent = "Espera la conexión e identificación del satélite.";
    return false;
  }
  if (!quiet) elements["voice-status"].textContent = "Consultando voces del servidor…";
  elements["voice-list"].replaceChildren();
  try {
    const response = await fetch(`${voiceApiUrl}/satellites/${encodeURIComponent(localSatelliteId)}`, { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    voiceState = result;
    elements["voice-summary"].textContent = voiceState.voices.find((item) => item.id === voiceState.selectedVoiceId)?.name || "Sin voces disponibles";
    if (!quiet) elements["voice-status"].textContent = "";
    renderVoices();
    return true;
  } catch (error) {
    if (!quiet) elements["voice-status"].textContent = error.message;
    elements["voice-summary"].textContent = "No disponible";
    return false;
  }
}

async function openVoices() {
  showScreen("voice-screen");
  await loadVoiceConfig();
}

async function previewVoice() {
  if (!voiceApiUrl || !localSatelliteId) return;
  elements["voice-preview"].disabled = true;
  elements["voice-status"].textContent = "Solicitando prueba al servidor…";
  try {
    const response = await fetch(`${voiceApiUrl}/satellites/${encodeURIComponent(localSatelliteId)}/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    elements["voice-status"].textContent = "Prueba enviada al satélite.";
  } catch (error) {
    elements["voice-status"].textContent = error.message;
  } finally {
    elements["voice-preview"].disabled = false;
  }
}

async function startBrowserAudio() {
  if (browserAudioStarting) return browserAudioStarting;
  const selected = serverState;
  if (!selected || !localSatelliteId) return false;
  browserAudioStarting = (async () => {
    const assistant = storedAssistantConfig();
    try {
      await browserAudio.start({
        webSocketUrl: selected.webSocketUrl,
        satelliteId: localSatelliteId,
        satellite: {
          id: localSatelliteId,
          runtime: "browser",
          name: assistant.name,
          userAgent: navigator.userAgent
        },
        wakeWord: wakeWordPayload(assistant)
      });
      return true;
    } catch (error) {
      elements.connection.className = "badge text-bg-danger";
      elements.connection.textContent = "Audio no disponible";
      elements.response.textContent = `No se pudo iniciar el audio: ${error.message}`;
      return false;
    } finally {
      browserAudioStarting = null;
    }
  })();
  return browserAudioStarting;
}

browserAudio.addEventListener("audio.level", ({ detail }) => updateAudioMeter(detail.level));
browserAudio.addEventListener("connection.state", ({ detail }) => {
  const presentation = {
    connecting: ["badge text-bg-warning", "Conectando"],
    connected: ["badge text-bg-success", "Conectado"],
    disconnected: ["badge text-bg-danger", "Desconectado"]
  }[detail.state];
  if (!presentation) return;
  [elements.connection.className, elements.connection.textContent] = presentation;
});
browserAudio.addEventListener("incompatible", () => {
  elements.connection.className = "badge text-bg-danger";
  elements.connection.textContent = "Servidor incompatible";
});
browserAudio.addEventListener("error", ({ detail }) => {
  elements.response.textContent = `Audio: ${detail.message}`;
});

document.addEventListener("pointerdown", () => { void browserAudio.resume(); }, { passive: true });

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
  if (!serverState) await loadServer();
  const selected = serverState;
  if (!selected || generation !== displaySocketGeneration) {
    elements.connection.className = "badge text-bg-warning";
    elements.connection.textContent = "Buscando servidor";
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
    if (event.protocolVersion !== "5") {
      elements.connection.className = "badge text-bg-danger";
      elements.connection.textContent = "Servidor incompatible";
      socket.close();
      return;
    }
    const isLocalSatelliteEvent = Boolean(localSatelliteId) && event.source === localSatelliteId;
    const isLocalAssistantEvent = Boolean(localSatelliteId) && event.payload?.targetSatelliteId === localSatelliteId;
    if (["voice.transcript.partial", "voice.transcript.received"].includes(event.type) && !isLocalSatelliteEvent) return;
    if (["voice.state.changed", "assistant.processing.started", "assistant.response.created"].includes(event.type) && !isLocalAssistantEvent) return;
    if (event.type === "voice.transcript.received") {
      elements.transcript.textContent = event.payload.text;
    }
    if (event.type === "voice.transcript.partial") {
      elements.transcript.textContent = event.payload.text || "Escuchando…";
    }
    if (event.type === "voice.state.changed") {
      const state = event.payload.state;
      listeningGeneration += 1;
      if (state === "wake_detected") {
        setListeningIndicator(true, "Activación detectada");
        elements.transcript.textContent = "Activación detectada…";
      } else if (state === "listening") {
        setListeningIndicator(true, "Te escucho");
        if (!event.payload.reason?.includes("stt_wake_word")) elements.transcript.textContent = "Escuchando…";
      } else if (state === "follow_up_listening") {
        setListeningIndicator(true, "Puedes responder");
        elements.transcript.textContent = "Puedes responder…";
      } else if (state === "processing") {
        setListeningIndicator(false);
        elements.response.textContent = "Procesando tu solicitud…";
        elements.response.classList.add("processing");
      } else if (state === "speaking") {
        setListeningIndicator(false);
        elements.response.classList.remove("processing");
      } else if (state === "interrupted") {
        setListeningIndicator(false);
        elements.transcript.textContent = "Interrumpiendo…";
      } else if (state === "idle") {
        setListeningIndicator(false);
        elements.response.classList.remove("processing");
        const reason = event.payload.reason || "";
        if (reason.includes("timeout")) elements.transcript.textContent = "No escuché ningún comando.";
        else if (reason === "false_detection_reported") elements.transcript.textContent = "Detección falsa reportada para futuros entrenamientos.";
        else if (!["completed", "tts_playback_completed", "response_without_speech"].includes(reason)) {
          elements.transcript.textContent = "Esperando voz…";
        }
      }
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
  });
}

enableTouchButtonActivation();
document.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", async () => {
  showScreen(button.dataset.screen);
  if (button.dataset.screen === "settings-screen") {
    await loadServer();
    await Promise.all([loadAudio(), loadAssistantConfig(), loadMusicDestinations(), loadHomeDevices(), loadSystemInformation()]);
  }
  if (button.dataset.screen === "server-settings-screen") {
    await loadServer();
    await Promise.all([loadLocation(), loadLlmConfig(), loadMusicAssistantStatus()]);
  }
  if (button.dataset.screen === "assistant-screen") await loadAssistantConfig();
  if (button.dataset.screen === "voice-screen") await openVoices();
  if (button.dataset.screen === "location-screen") await loadLocation();
  if (button.dataset.screen === "llm-screen") await loadLlmConfig();
  if (button.dataset.screen === "music-destinations-screen") await loadMusicDestinations();
  if (button.dataset.screen === "music-sources-screen") await loadMusicDestinations();
  if (button.dataset.screen === "music-assistant-screen") await loadMusicAssistantStatus();
  if (button.dataset.screen === "home-devices-screen") await loadHomeDevices();
  if (button.dataset.screen === "home-assistant-screen") await loadHomeDevices();
  if (button.dataset.screen === "system-info-screen") await loadSystemInformation();
}));
elements["refresh-system-info"].addEventListener("click", loadSystemInformation);
document.querySelectorAll("[data-audio-kind]").forEach((button) => button.addEventListener("click", () => openAudio(button.dataset.audioKind)));
elements["assistant-form"].addEventListener("submit", saveAssistantName);
elements["connected-power-device-open"].addEventListener("click", () => openSelectionScreen({
  title: "Enchufe asociado",
  help: "Selecciona el enchufe que alimenta este satélite.",
  returnScreen: "assistant-screen",
  options: connectedPowerOptions,
  selectedId: elements["connected-power-device"].value,
  onSelect: (option) => {
    elements["connected-power-device"].value = option.id;
    renderConnectedPowerDeviceLabel();
  }
}));
elements["manual-listen"].addEventListener("click", startManualListening);
elements["location-form"].addEventListener("submit", saveLocation);
elements["detect-location"].addEventListener("click", detectLocation);
elements["llm-provider-open"].addEventListener("click", () => openSelectionScreen({
  title: "Proveedor del modelo",
  help: "Selecciona el servicio que ejecutará el modelo de lenguaje.",
  returnScreen: "llm-screen",
  options: llmProviderOptions,
  selectedId: elements["llm-provider"].value,
  onSelect: (option) => {
    elements["llm-provider"].value = option.id;
    elements["llm-provider-label"].textContent = option.name;
    renderLlmFields({ applyDefaults: true });
  }
}));
elements["selection-back"].addEventListener("click", () => showScreen(selectionReturnScreen));
elements["llm-form"].addEventListener("submit", saveLlmConfiguration);
elements["llm-test"].addEventListener("click", testLlmConfiguration);
elements["llm-delete-credential"].addEventListener("click", deleteLlmCredential);
elements["home-assistant-form"].addEventListener("submit", saveHomeAssistantConnection);
elements["home-assistant-test"].addEventListener("click", testHomeAssistantConnection);
elements["home-assistant-delete-credential"].addEventListener("click", deleteHomeAssistantCredential);
elements["discover-music-destinations"].addEventListener("click", () => loadMusicDestinations({ discover: true }));
elements["voice-preview"].addEventListener("click", previewVoice);
elements["music-assistant-form"].addEventListener("submit", connectMusicAssistant);
elements["playback-previous"].addEventListener("click", () => runPlaybackCommand("previous"));
elements["playback-toggle"].addEventListener("click", () => runPlaybackCommand(playbackSnapshot?.status === "playing" ? "pause" : "resume"));
elements["playback-next"].addEventListener("click", () => runPlaybackCommand("next"));
elements["playback-volume"].addEventListener("pointerdown", () => { playbackVolumeEditing = true; });
elements["playback-volume"].addEventListener("input", () => {
  playbackVolumeEditing = true;
  elements["playback-volume-value"].textContent = `${elements["playback-volume"].value}%`;
  schedulePlaybackVolumeCommit(350);
});
elements["playback-volume"].addEventListener("change", () => schedulePlaybackVolumeCommit());
elements["playback-volume"].addEventListener("pointerup", () => schedulePlaybackVolumeCommit());
elements["playback-volume"].addEventListener("pointercancel", () => schedulePlaybackVolumeCommit());
elements["playback-volume"].addEventListener("blur", () => schedulePlaybackVolumeCommit());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void loadCurrentPlayback();
});
window.addEventListener("focus", () => void loadCurrentPlayback());
window.addEventListener("pagehide", () => { void browserAudio.stop(); });

enableConfigurationDragScrolling();
updateClock();
setInterval(updateClock, 1000);
elements["playback-cover"].addEventListener("error", () => {
  elements["playback-cover"].classList.remove("visible");
  elements["playback-cover-placeholder"].classList.remove("hidden");
});
void (async () => {
  await Promise.all([loadLocalIdentity(), loadServer()]);
  connect();
  await Promise.all([
    loadVoiceConfig({ quiet: true }),
    loadMusicDestinations(),
    loadCurrentPlayback()
  ]);
  void startBrowserAudio();
})();
setInterval(() => { if (!document.hidden) void loadCurrentPlayback(); }, 2_000);
setInterval(() => { if (musicApiUrl) void loadMusicAssistantStatus(); }, 30_000);
setInterval(updatePlaybackProgress, 1000);
