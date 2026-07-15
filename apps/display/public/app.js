const elements = Object.fromEntries([
  "clock", "date", "connection", "weather", "weather-icon", "weather-condition", "moon-phase", "moon-icon", "moon-phase-name", "track", "device", "transcript", "response",
  "playback-cover", "playback-cover-placeholder", "playback-artists", "playback-album", "playback-progress-bar", "playback-time",
  "playback-previous", "playback-toggle", "playback-next", "playback-controls-status",
  "input-summary", "output-summary", "audio-title", "audio-help", "audio-status", "device-list",
  "channel-status", "channel-list", "audio-level-db", "audio-level-bar", "audio-level-peak",
  "assistant-summary", "assistant-form", "assistant-name", "assistant-status"
  , "voice-summary", "voice-status", "voice-list"
  , "location-summary", "location-form", "location-city", "location-region", "location-country",
  "location-latitude", "location-longitude", "location-time-zone", "location-status", "detect-location"
  , "music-destinations-summary", "music-destinations-status", "music-destinations-list", "discover-music-destinations"
  , "music-destination-title", "music-destination-detail", "music-destination-form", "music-destination-alias"
  , "music-destination-room", "music-destination-route", "music-destination-enabled", "music-destination-status"
  , "music-destination-active"
  , "spotify-connect-summary", "spotify-connect-form", "spotify-client-id", "spotify-redirect-uri"
  , "spotify-authorize", "spotify-connect-status", "spotify-devices-list"
].map((id) => [id, document.getElementById(id)]));

const audioApiUrl = `${location.protocol}//${location.hostname || "localhost"}:3200/audio`;
const assistantApiUrl = `${location.protocol}//${location.hostname || "localhost"}:3200/assistant`;
const locationApiUrl = `${location.protocol}//${location.hostname || "localhost"}:3000/config/location`;
const musicApiUrl = `${location.protocol}//${location.hostname || "localhost"}:3100/v1`;
let audioState = null;
let musicState = null;
let activeMusicDestinationId = null;
let activeAudioKind = "input";
let displayedAudioLevel = 0;
let peakAudioLevel = 0;
let peakHoldUntil = 0;
let playbackSnapshot = null;
let playbackReceivedAt = 0;

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

function renderPlayback(playback = {}) {
  playbackSnapshot = playback;
  playbackReceivedAt = Date.now();
  const item = playback.item;
  elements.track.textContent = item?.name || item?.title || "Sin reproducción";
  elements["playback-artists"].textContent = item?.artists?.join(", ") || "";
  elements["playback-album"].textContent = item?.album || "";
  const device = typeof playback.device === "string" ? playback.device : playback.device?.name;
  const status = playback.status === "paused" ? "Pausado" : playback.status === "playing" ? "Reproduciendo" : "Sin reproducción";
  elements.device.textContent = `${status} · ${device || "Sin dispositivo"}`;
  const hasPlayback = Boolean(item);
  elements["playback-previous"].disabled = !hasPlayback;
  elements["playback-next"].disabled = !hasPlayback;
  elements["playback-toggle"].disabled = !hasPlayback;
  const isPlaying = playback.status === "playing";
  elements["playback-toggle"].textContent = isPlaying ? "Ⅱ" : "▶";
  elements["playback-toggle"].setAttribute("aria-label", isPlaying ? "Pausar" : "Reproducir");
  updatePlaybackProgress();
  const artworkUrl = item?.artwork?.url;
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
  try {
    const response = await fetch(`${musicApiUrl}/music/playback`);
    if (!response.ok) return false;
    renderPlayback(await response.json());
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
  const spotify = musicState.integrations?.spotify;
  elements["spotify-connect-summary"].textContent = spotify?.connected ? "Cuenta conectada" : (spotify?.clientId ? "Pendiente de conectar" : "Sin configurar");
}

function destinationDisplayName(destination) {
  return destination.alias || destination.name;
}

function renderMusicDestinations() {
  const destinations = musicState?.destinations || [];
  elements["music-destinations-list"].replaceChildren(...destinations.map((destination) => {
    const button = document.createElement("button");
    button.className = `destination-card${destination.available ? "" : " offline"}`;
    button.type = "button";
    button.innerHTML = '<span class="destination-icon">🔊</span><span><strong></strong><small class="destination-meta"></small><small class="destination-route"></small></span><span class="chevron">›</span>';
    button.querySelector("strong").textContent = destinationDisplayName(destination);
    const meta = button.querySelector(".destination-meta");
    const dot = document.createElement("span");
    dot.className = `availability-dot${destination.available ? " online" : ""}`;
    meta.replaceChildren(dot, document.createTextNode(`${destination.available ? "Disponible" : "Desconectado"}${destination.room ? ` · ${destination.room}` : ""}`));
    const route = destination.routes.find((item) => item.id === destination.preferredRouteId);
    button.querySelector(".destination-route").textContent = `${destination.active ? "Activo · " : ""}${route?.label || "Sin ruta configurada"}`;
    button.addEventListener("click", () => openMusicDestination(destination.id));
    return button;
  }));
  if (!destinations.length) elements["music-destinations-status"].textContent = "Aún no hay destinos disponibles. Inicia una búsqueda para actualizar la lista.";
  updateMusicSummary();
}

async function loadMusicDestinations({ discover = false } = {}) {
  elements["music-destinations-status"].textContent = discover ? "Buscando reproductores…" : "Cargando destinos…";
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
    return true;
  } catch (error) {
    elements["music-destinations-status"].textContent = "No se pudo conectar con Music Gateway.";
    return false;
  } finally {
    elements["discover-music-destinations"].disabled = false;
  }
}

function fillSpotifyConfig() {
  const spotify = musicState?.integrations?.spotify;
  if (!spotify) return;
  elements["spotify-client-id"].value = spotify.clientId || "";
  elements["spotify-redirect-uri"].value = spotify.redirectUri || "";
  elements["spotify-authorize"].textContent = spotify.connected ? "Reconectar Spotify" : "Conectar Spotify";
  updateMusicSummary();
}

async function saveSpotifyConfig(event) {
  event.preventDefault();
  elements["spotify-connect-status"].textContent = "Guardando…";
  try {
    const response = await fetch(`${musicApiUrl}/integrations/spotify`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: elements["spotify-client-id"].value, redirectUri: elements["spotify-redirect-uri"].value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    musicState.integrations.spotify = result;
    fillSpotifyConfig();
    elements["spotify-connect-status"].textContent = "Configuración guardada";
  } catch (error) {
    elements["spotify-connect-status"].textContent = error.message;
  }
}

async function authorizeSpotify() {
  elements["spotify-connect-status"].textContent = "Preparando autorización…";
  const authWindow = window.open("", "spotify-auth");
  try {
    await saveSpotifyConfig(new Event("submit"));
    const response = await fetch(`${musicApiUrl}/integrations/spotify/authorize`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    if (authWindow) authWindow.location = result.authorizationUrl;
    else window.location.href = result.authorizationUrl;
    elements["spotify-connect-status"].textContent = "Completa la autorización de Spotify y luego vuelve a buscar dispositivos.";
  } catch (error) {
    if (authWindow) authWindow.close();
    elements["spotify-connect-status"].textContent = error.message;
  }
}

function renderDiscoveredSpotifyDevices(devices) {
  const savedIds = new Set((musicState?.destinations || []).map((item) => item.id));
  elements["spotify-devices-list"].replaceChildren(...devices.map((device) => {
    const card = document.createElement("div");
    card.className = "destination-card";
    card.innerHTML = '<span class="destination-icon">♫</span><span><strong></strong><small class="destination-meta"></small></span><button class="save-button compact" type="button"></button>';
    card.querySelector("strong").textContent = device.name;
    card.querySelector(".destination-meta").textContent = `${device.model}${device.active ? " · En reproducción" : ""}${device.restricted ? " · Control restringido" : ""}`;
    const button = card.querySelector("button");
    button.textContent = savedIds.has(device.id) ? "Agregado" : "Agregar";
    button.disabled = savedIds.has(device.id) || device.restricted;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch(`${musicApiUrl}/destinations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(device) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
        musicState.destinations.push(result);
        button.textContent = "Agregado";
        renderMusicDestinations();
      } catch (error) {
        button.disabled = false;
        elements["spotify-connect-status"].textContent = error.message;
      }
    });
    return card;
  }));
}

async function discoverSpotifyDevices() {
  elements["discover-music-destinations"].disabled = true;
  elements["spotify-connect-status"].textContent = "Consultando dispositivos disponibles en Spotify…";
  try {
    const response = await fetch(`${musicApiUrl}/destinations/discover`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    musicState = result;
    fillSpotifyConfig();
    renderMusicDestinations();
    renderDiscoveredSpotifyDevices(result.discovered || []);
    elements["spotify-connect-status"].textContent = result.errors?.length
      ? result.errors.map((item) => item.message).join(" · ")
      : result.discovered.length
        ? `${result.discovered.length} dispositivo(s) encontrado(s)`
        : "Spotify no devolvió dispositivos disponibles. Abre Spotify con esta misma cuenta, inicia una reproducción, selecciona el equipo desde Conectar a un dispositivo y vuelve a buscar.";
  } catch (error) {
    elements["spotify-connect-status"].textContent = error.message;
  } finally {
    elements["discover-music-destinations"].disabled = false;
  }
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
  elements["music-destination-route"].replaceChildren(...destination.routes.map((route) => {
    const option = document.createElement("option");
    option.value = route.id;
    option.textContent = `${route.label}${route.available ? "" : " (no disponible)"}`;
    option.selected = route.id === destination.preferredRouteId;
    return option;
  }));
  elements["music-destination-detail"].textContent = [destination.name, destination.model, `Origen: ${destination.source}`].filter(Boolean).join(" · ");
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
    elements["music-destination-status"].textContent = `${destinationDisplayName(result)} es ahora el destino activo`;
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
        preferredRouteId: elements["music-destination-route"].value,
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
  return audioState?.devices[kind].find((device) => device.id === id)?.name || (id ? "Dispositivo no disponible" : "Sin configurar");
}

function updateAudioSummaries() {
  if (!audioState) return;
  const channel = Number.isInteger(audioState.config.inputChannel) ? ` · Canal ${audioState.config.inputChannel + 1}` : "";
  elements["input-summary"].textContent = `${deviceName("input", audioState.config.inputDeviceId)}${channel}`;
  elements["output-summary"].textContent = deviceName("output", audioState.config.outputDeviceId);
  const voice = audioState.voices?.find((item) => item.id === audioState.config.ttsVoiceId) || audioState.voices?.[0];
  elements["voice-summary"].textContent = voice?.name || "Sin voces disponibles";
}

async function loadAudio() {
  elements["audio-status"].textContent = "Buscando dispositivos…";
  try {
    const response = await fetch(audioApiUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    audioState = await response.json();
    elements["audio-status"].textContent = "";
    updateAudioSummaries();
    return true;
  } catch (error) {
    elements["audio-status"].textContent = "No se pudo conectar con el servicio de audio del satélite.";
    return false;
  }
}

function renderDevices() {
  const configKey = activeAudioKind === "input" ? "inputDeviceId" : "outputDeviceId";
  const selectedId = audioState.config[configKey];
  elements["device-list"].replaceChildren(...audioState.devices[activeAudioKind].map((device) => {
    const button = document.createElement("button");
    button.className = `device-option${device.id === selectedId ? " selected" : ""}`;
    button.disabled = !device.available;
    button.innerHTML = `<span><strong></strong><small></small></span><span class="selection-mark">${device.id === selectedId ? "✓" : ""}</span>`;
    button.querySelector("strong").textContent = device.name;
    button.querySelector("small").textContent = device.simulated ? "Modo simulador" : (device.available ? "Disponible" : "No disponible");
    button.addEventListener("click", () => selectDevice(configKey, device.id));
    return button;
  }));
}

async function openAudio(kind) {
  activeAudioKind = kind;
  showScreen("audio-screen");
  elements["audio-title"].textContent = kind === "input" ? "Micrófono" : "Salida de voz";
  elements["audio-help"].textContent = kind === "input"
    ? "Elige el dispositivo que escuchará tus solicitudes."
    : "Elige dónde se reproducirán las respuestas del asistente.";
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
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  audioState.config = result.config;
  updateAudioSummaries();
}

async function selectDevice(configKey, deviceId) {
  elements["audio-status"].textContent = "Guardando…";
  document.querySelectorAll(".device-option").forEach((button) => { button.disabled = true; });
  try {
    await saveConfig({ [configKey]: deviceId });
    if (configKey === "inputDeviceId") {
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

function connect() {
  let listeningGeneration = 0;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const host = location.hostname || "localhost";
  const socket = new WebSocket(`${protocol}://${host}:3000/ws`);
  socket.addEventListener("open", () => { elements.connection.className = "badge text-bg-success"; elements.connection.textContent = "Conectado"; });
  socket.addEventListener("close", () => { elements.connection.className = "badge text-bg-danger"; elements.connection.textContent = "Desconectado"; updateAudioMeter({}); setTimeout(connect, 3000); });
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
      renderPlayback(event.payload);
    }
  });
}

document.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", async () => {
  showScreen(button.dataset.screen);
  if (button.dataset.screen === "settings-screen") await Promise.all([loadAudio(), loadAssistantConfig(), loadLocation(), loadMusicDestinations()]);
  if (button.dataset.screen === "assistant-screen") await loadAssistantConfig();
  if (button.dataset.screen === "voice-screen") await openVoices();
  if (button.dataset.screen === "location-screen") await loadLocation();
  if (button.dataset.screen === "music-destinations-screen") await loadMusicDestinations();
  if (button.dataset.screen === "spotify-connect-screen") {
    if (!musicState) await loadMusicDestinations();
    fillSpotifyConfig();
  }
}));
document.querySelectorAll("[data-audio-kind]").forEach((button) => button.addEventListener("click", () => openAudio(button.dataset.audioKind)));
elements["assistant-form"].addEventListener("submit", saveAssistantName);
elements["location-form"].addEventListener("submit", saveLocation);
elements["detect-location"].addEventListener("click", detectLocation);
elements["discover-music-destinations"].addEventListener("click", discoverSpotifyDevices);
elements["music-destination-form"].addEventListener("submit", saveMusicDestination);
elements["music-destination-active"].addEventListener("click", setActiveMusicDestination);
elements["spotify-connect-form"].addEventListener("submit", saveSpotifyConfig);
elements["spotify-authorize"].addEventListener("click", authorizeSpotify);
elements["playback-previous"].addEventListener("click", () => runPlaybackCommand("previous"));
elements["playback-toggle"].addEventListener("click", () => runPlaybackCommand(playbackSnapshot?.status === "playing" ? "pause" : "resume"));
elements["playback-next"].addEventListener("click", () => runPlaybackCommand("next"));

updateClock();
setInterval(updateClock, 1000);
elements["playback-cover"].addEventListener("error", () => {
  elements["playback-cover"].classList.remove("visible");
  elements["playback-cover-placeholder"].classList.remove("hidden");
});
void loadCurrentPlayback();
setInterval(() => void loadCurrentPlayback(), 5000);
setInterval(updatePlaybackProgress, 1000);
connect();
