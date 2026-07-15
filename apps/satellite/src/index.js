import WebSocket from "ws";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createEvent, EventType } from "@ha/contracts";
import { env, jsonLog } from "@ha/shared";
import { createAudioDeviceProvider, listAudioDevices } from "./audio/index.js";
import { VoiceCapture } from "./voice/voice-capture.js";
import { VoskWakeWordDetector } from "./voice/vosk-wake-word-detector.js";
import { createTextToSpeechProvider } from "./tts/index.js";
import {
  readAssistantConfig,
  validateAssistantNameWithVosk,
  writeAssistantConfig
} from "./config/assistant-config.js";
import { ServerDiscovery } from "./discovery/server-discovery.js";
import { ServerSelection, serverFromManualUrl } from "./discovery/server-selection.js";

const configuredServerUrl = process.env.SERVER_URL?.trim() || null;
const configuredSpeechToTextUrl = process.env.SPEECH_TO_TEXT_URL?.trim() || null;
const satellite = { id: env("SATELLITE_ID", "simulator-1"), room: env("SATELLITE_ROOM", "development") };
const audioApiPort = Number(env("AUDIO_API_PORT", "3200"));
const audioConfigPath = env("AUDIO_CONFIG_PATH", "dev/satellite/config/audio.json");
const assistantConfigPath = env("ASSISTANT_CONFIG_PATH", "dev/satellite/config/assistant.json");
const satelliteServerConfigPath = env("SERVER_CONFIG_PATH", "dev/satellite/config/server.json");
const defaultAudioConfig = { inputDeviceId: null, inputChannel: null, outputDeviceId: null, ttsVoiceId: null };
const audioDeviceProvider = createAudioDeviceProvider();
const textToSpeechProvider = createTextToSpeechProvider(jsonLog);
const wakeWordProvider = env("WAKE_WORD_PROVIDER", "vosk");
const commandWindowMs = Number(env("WAKE_WORD_COMMAND_TIMEOUT_MS", "7000"));
const wakeWordMinConfidence = Number(env("WAKE_WORD_MIN_CONFIDENCE", "0.82"));
const voskOptions = {
  python: env("VOSK_PYTHON", "dev/satellite/.venv/bin/python"),
  scriptPath: env("VOSK_SCRIPT_PATH", "apps/satellite/src/voice/vosk_detector.py"),
  modelPath: env("VOSK_MODEL_PATH", "dev/satellite/models/vosk-model-small-es-0.42")
};
let activeSocket = null;
let activeServer = null;
let reconnectTimer = null;
let connectionGeneration = 0;
let activationExpiresAt = 0;
let dedicatedWakeWordActive = false;
let wakeWordDetector = null;
let voiceCapture = null;
let assistantConfig = await readAssistantConfig(assistantConfigPath, jsonLog);
const manualServer = configuredServerUrl ? serverFromManualUrl(configuredServerUrl, configuredSpeechToTextUrl) : null;
const serverDiscovery = new ServerDiscovery({ log: jsonLog });
const serverSelection = new ServerSelection({
  discovery: serverDiscovery,
  configPath: satelliteServerConfigPath,
  manualServer,
  log: jsonLog,
  onSelected: (server) => applySelectedServer(server)
});

function sendListeningEnded(reason) {
  activationExpiresAt = 0;
  if (activeSocket?.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify(createEvent(EventType.LISTENING_ENDED, { reason }, satellite.id)));
  }
}

function createWakeWordDetector(name) {
  return new VoskWakeWordDetector({
    ...voskOptions,
    wakeWord: name,
    cooldownMs: Number(env("WAKE_WORD_COOLDOWN_MS", "2000")),
    minConfidence: wakeWordMinConfidence,
    log: jsonLog,
    onDetected: (detection) => {
      if (Date.now() <= activationExpiresAt) {
        jsonLog("info", "Wake word repetida ignorada durante la ventana activa", detection);
        return;
      }
      activationExpiresAt = Date.now() + commandWindowMs;
      voiceCapture?.arm(commandWindowMs);
      jsonLog("info", "Wake word detectada por Vosk", detection);
      if (activeSocket?.readyState === WebSocket.OPEN) {
        activeSocket.send(JSON.stringify(createEvent(EventType.WAKE_WORD_DETECTED, { wakeWord: name, timeoutMs: commandWindowMs }, satellite.id)));
      }
    }
  });
}

async function replaceWakeWordDetector(name) {
  if (wakeWordProvider !== "vosk") return;
  const replacement = createWakeWordDetector(name);
  await replacement.start();
  const previous = wakeWordDetector;
  wakeWordDetector = replacement;
  dedicatedWakeWordActive = true;
  activationExpiresAt = 0;
  previous?.stop();
  jsonLog("info", "Detector Vosk iniciado", { wakeWord: name });
}

if (wakeWordProvider === "vosk") {
  try {
    await replaceWakeWordDetector(assistantConfig.name);
  } catch (error) {
    jsonLog("warn", "No se pudo iniciar Vosk; se usará detección mediante Whisper", { error: error.message });
    wakeWordDetector?.stop();
  }
}

async function readAudioConfig() {
  try {
    return { ...defaultAudioConfig, ...JSON.parse(await readFile(audioConfigPath, "utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") jsonLog("warn", "No se pudo leer la configuración de audio", { error: error.message });
    return { ...defaultAudioConfig };
  }
}

async function writeAudioConfig(config) {
  await mkdir(dirname(audioConfigPath), { recursive: true });
  const temporaryPath = `${audioConfigPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporaryPath, audioConfigPath);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Content-Type": "application/json"
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Solicitud demasiado grande");
  }
  return JSON.parse(body);
}

async function handleAudioApi(request, response) {
  if (request.method === "OPTIONS") return sendJson(response, 204, {});
  const url = new URL(request.url, "http://localhost");

  if (request.method === "GET" && (url.pathname === "/server" || url.pathname === "/servers")) {
    return sendJson(response, 200, serverSelection.state());
  }

  if (request.method === "POST" && url.pathname === "/servers/discover") {
    return sendJson(response, 200, serverSelection.refresh());
  }

  if (request.method === "PUT" && url.pathname === "/server") {
    try {
      const update = await readJsonBody(request);
      return sendJson(response, 200, await serverSelection.select(update.id));
    } catch (error) {
      return sendJson(response, 422, { error: "invalid_server", message: error.message });
    }
  }

  if (request.method === "GET" && url.pathname === "/assistant") {
    return sendJson(response, 200, { config: assistantConfig, provider: wakeWordProvider });
  }

  if (request.method === "PUT" && url.pathname === "/assistant") {
    try {
      const update = await readJsonBody(request);
      const name = wakeWordProvider === "vosk"
        ? await validateAssistantNameWithVosk(update.name, voskOptions)
        : update.name;
      await replaceWakeWordDetector(name);
      assistantConfig = { name };
      await writeAssistantConfig(assistantConfigPath, assistantConfig);
      jsonLog("info", "Nombre del asistente actualizado", { name });
      return sendJson(response, 200, { config: assistantConfig, provider: wakeWordProvider });
    } catch (error) {
      jsonLog("warn", "Nombre del asistente rechazado", { error: error.message });
      return sendJson(response, 422, { error: "invalid_assistant_name", message: error.message });
    }
  }

  if (request.method === "GET" && url.pathname === "/audio") {
    const [config, devices, voices] = await Promise.all([
      readAudioConfig(),
      listAudioDevices(audioDeviceProvider, (kind, error) => {
        jsonLog("warn", "Se usará el dispositivo de audio simulado", { provider: audioDeviceProvider.name, kind, error: error.message });
      }),
      textToSpeechProvider.listVoices().catch((error) => {
        jsonLog("warn", "No se pudieron enumerar las voces TTS", { provider: textToSpeechProvider.name, error: error.message });
        return [];
      })
    ]);
    return sendJson(response, 200, {
      config,
      devices: { input: devices.input, output: devices.output },
      voices,
      provider: devices.provider,
      ttsProvider: textToSpeechProvider.name
    });
  }

  if (request.method === "GET" && url.pathname === "/audio/input-channels") {
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) return sendJson(response, 400, { error: "device_id_required" });
    try {
      return sendJson(response, 200, { deviceId, channels: await audioDeviceProvider.listInputChannels(deviceId) });
    } catch (error) {
      jsonLog("warn", "No se pudieron consultar los canales de entrada", { deviceId, error: error.message });
      return sendJson(response, 422, { error: "input_channels_unavailable", message: error.message });
    }
  }

  if (request.method === "PUT" && url.pathname === "/audio") {
    try {
      const update = await readJsonBody(request);
      const config = await readAudioConfig();
      const previousInputDeviceId = config.inputDeviceId;
      for (const key of ["inputDeviceId", "outputDeviceId"]) {
        if (key in update && update[key] !== null && typeof update[key] !== "string") throw new Error(`Valor inválido: ${key}`);
        if (key in update) config[key] = update[key];
      }
      if ("inputChannel" in update && update.inputChannel !== null && (!Number.isInteger(update.inputChannel) || update.inputChannel < 0)) {
        throw new Error("Valor inválido: inputChannel");
      }
      if ("ttsVoiceId" in update) {
        if (update.ttsVoiceId !== null && typeof update.ttsVoiceId !== "string") throw new Error("Valor inválido: ttsVoiceId");
        const voices = await textToSpeechProvider.listVoices();
        if (update.ttsVoiceId !== null && !voices.some((voice) => voice.id === update.ttsVoiceId)) throw new Error("La voz seleccionada no está disponible");
        config.ttsVoiceId = update.ttsVoiceId;
      }
      if ("inputDeviceId" in update && update.inputDeviceId !== previousInputDeviceId) config.inputChannel = null;
      if (Number.isInteger(update.inputChannel)) {
        if (!config.inputDeviceId) throw new Error("Selecciona primero un dispositivo de entrada");
        const channels = await audioDeviceProvider.listInputChannels(config.inputDeviceId);
        if (!channels.some((channel) => channel.id === update.inputChannel)) throw new Error("El canal no existe en el dispositivo seleccionado");
      }
      if ("inputChannel" in update) config.inputChannel = update.inputChannel;
      await writeAudioConfig(config);
      jsonLog("info", "Configuración de audio actualizada", config);
      return sendJson(response, 200, { config });
    } catch (error) {
      return sendJson(response, 400, { error: "invalid_audio_config", message: error.message });
    }
  }

  return sendJson(response, 404, { error: "not_found" });
}

createServer((request, response) => {
  handleAudioApi(request, response).catch((error) => {
    jsonLog("warn", "Error en API de audio", { error: error.message });
    sendJson(response, 500, { error: "internal_error" });
  });
}).listen(audioApiPort, "0.0.0.0", () => jsonLog("info", "API local de audio iniciada", { port: audioApiPort }));

voiceCapture = new VoiceCapture({
  readConfig: readAudioConfig,
  log: jsonLog,
  silenceDuration: Number(env("VOICE_SILENCE_DURATION_MS", "800")) / 1000,
  maxPhraseSeconds: Number(env("VOICE_MAX_PHRASE_SECONDS", "8")),
  noiseFloorDb: Number(env("VOICE_INITIAL_NOISE_FLOOR_DB", "-50")),
  speechStartMarginDb: Number(env("VOICE_SPEECH_START_MARGIN_DB", "10")),
  speechEndMarginDb: Number(env("VOICE_SPEECH_END_MARGIN_DB", "6")),
  onAudio: (audio) => wakeWordDetector?.write(audio),
  onListeningTimeout: () => {
    jsonLog("info", "Ventana de voz terminada sin comando");
    sendListeningEnded("timeout");
  },
  onLevel: (level) => {
    if (activeSocket?.readyState === WebSocket.OPEN) {
      activeSocket.send(JSON.stringify(createEvent(EventType.AUDIO_LEVEL_UPDATED, level, satellite.id)));
    }
  },
  onPhrase: async (audio, { commandWasArmed = false } = {}) => {
    const detectedByWakeWord = dedicatedWakeWordActive && (commandWasArmed || Date.now() <= activationExpiresAt);
    if (dedicatedWakeWordActive && !detectedByWakeWord) return;
    // La ventana se consume antes de llamar al STT: nunca puede procesar más de
    // una frase ni ser extendida por ruido mientras la solicitud está en curso.
    if (detectedByWakeWord) activationExpiresAt = 0;
    if (!activeServer) throw new Error("No hay un servidor del asistente seleccionado y disponible");
    const response = await fetch(activeServer.speechToTextUrl, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Satellite-Id": satellite.id,
        "X-Wake-Word": assistantConfig.name,
        "X-Wake-Word-Detected": String(detectedByWakeWord)
      },
      body: audio
    });
    if (!response.ok) throw new Error(`STT respondió HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const result = await response.json();
    if (detectedByWakeWord && result.awaitingCommand) {
      activationExpiresAt = Date.now() + commandWindowMs;
      voiceCapture.arm(commandWindowMs);
      jsonLog("info", "Wake word sin comando; esperando una única frase", { timeoutMs: commandWindowMs });
    }
    if (detectedByWakeWord && !result.activated && !result.awaitingCommand) sendListeningEnded("not_understood");
    jsonLog("info", result.activated ? "Wake word detectada" : "Frase ignorada", {
      transcript: result.transcript,
      wakeWord: result.wakeWord
    });
  }
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let speechQueue = Promise.resolve();

function openFollowUpWindow(timeoutMs) {
  activationExpiresAt = Date.now() + timeoutMs;
  voiceCapture.arm(timeoutMs);
  if (activeSocket?.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify(createEvent(EventType.FOLLOW_UP_LISTENING_STARTED, { timeoutMs }, satellite.id)));
  }
  jsonLog("info", "Ventana de seguimiento abierta", { timeoutMs });
}

function enqueueSpeech(text, { expectsReply = false, followUpTimeoutMs = 5000 } = {}) {
  speechQueue = speechQueue.then(async () => {
    activationExpiresAt = 0;
    const config = await readAudioConfig();
    if (!config.outputDeviceId) {
      jsonLog("info", "Respuesta TTS omitida: no hay salida configurada");
      if (expectsReply) openFollowUpWindow(followUpTimeoutMs);
      return;
    }
    const voices = await textToSpeechProvider.listVoices();
    const voiceId = voices.some((voice) => voice.id === config.ttsVoiceId) ? config.ttsVoiceId : voices[0]?.id;
    voiceCapture.pause();
    try {
      jsonLog("info", "Reproduciendo respuesta TTS", { provider: textToSpeechProvider.name, voiceId, outputDeviceId: config.outputDeviceId });
      await textToSpeechProvider.speak(text, { outputDeviceId: config.outputDeviceId, voiceId });
      jsonLog("info", "Respuesta TTS reproducida", { provider: textToSpeechProvider.name, voiceId });
    } finally {
      await delay(200);
      voiceCapture.resume();
      if (expectsReply) openFollowUpWindow(followUpTimeoutMs);
    }
  }).catch((error) => jsonLog("warn", "No se pudo reproducir la respuesta TTS", { error: error.message }));
}

voiceCapture.start();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    clearTimeout(reconnectTimer);
    serverSelection.stop();
    activeSocket?.close();
    voiceCapture.stop();
    wakeWordDetector?.stop();
    setTimeout(() => process.exit(0), 250);
  });
}

function applySelectedServer(server) {
  activeServer = server;
  connectionGeneration += 1;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (activeSocket) {
    const previous = activeSocket;
    activeSocket = null;
    previous.close();
  }
  if (server) connect(server, connectionGeneration);
  else jsonLog("warn", "Esperando selección o descubrimiento de un servidor");
}

function scheduleReconnect(server, generation) {
  if (generation !== connectionGeneration || activeServer?.id !== server.id || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(server, generation);
  }, 3000);
}

function connect(server, generation = connectionGeneration) {
  if (!server || generation !== connectionGeneration) return;
  const socket = new WebSocket(server.webSocketUrl);
  activeSocket = socket;

  socket.on("open", () => {
    jsonLog("info", "Satélite conectado", { serverId: server.id, serverUrl: server.webSocketUrl, ...satellite });
    socket.send(JSON.stringify(createEvent(EventType.SATELLITE_CONNECTED, satellite, satellite.id)));
  });

  socket.on("message", (data) => {
    try {
      const event = JSON.parse(data.toString());
      jsonLog("info", "Evento para el satélite", { type: event.type, source: event.source });
      if (event.type === EventType.ASSISTANT_SPEECH_REQUESTED
        && (!event.payload.targetSatelliteId || event.payload.targetSatelliteId === satellite.id)
        && typeof event.payload.text === "string"
        && event.payload.text.trim()) {
        enqueueSpeech(event.payload.text.trim(), {
          expectsReply: event.payload.expectsReply === true,
          followUpTimeoutMs: 5000
        });
      }
    } catch (error) {
      jsonLog("warn", "Evento del servidor inválido", { error: error.message });
    }
  });
  socket.on("error", (error) => jsonLog("warn", "Error de conexión", { error: error.message }));
  socket.on("close", () => {
    if (activeSocket === socket) activeSocket = null;
    jsonLog("warn", "Satélite desconectado; reintentando");
    scheduleReconnect(server, generation);
  });

  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(createEvent(EventType.SATELLITE_HEARTBEAT, satellite, satellite.id)));
    }
  }, 15000);
  socket.on("close", () => clearInterval(heartbeat));
}

await serverSelection.start();
