import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createEvent, EventType, isEvent } from "@ha/contracts";
import { configPath, env, jsonLog, readReleaseVersion } from "@ha/shared";
import { createAudioDeviceProvider, listAudioDevices } from "./audio/index.js";
import { pcmToWav, VoiceCapture } from "./voice/voice-capture.js";
import { VoskWakeWordDetector } from "./voice/vosk-wake-word-detector.js";
import { OpenWakeWordDetector } from "./voice/openwakeword-detector.js";
import { WakeWordModelManager } from "./voice/wake-word-model-manager.js";
import { OneShotCommandRetry, WakeActivationGate } from "./voice/wake-activation-gate.js";
import { createTextToSpeechProvider } from "./tts/index.js";
import {
  normalizeConnectedPowerDeviceId,
  normalizeAssistantName,
  normalizeWakeWordSelection,
  readAssistantConfig,
  validateAssistantNameWithVosk,
  writeAssistantConfig
} from "./config/assistant-config.js";
import { ServerDiscovery } from "./discovery/server-discovery.js";
import { ServerSelection } from "./discovery/server-selection.js";
import { OutputVolumeDucker } from "./audio/output-volume-ducker.js";
import { SendspinPlayer } from "./music/sendspin-player.js";
import { getSystemInformation } from "./system/system-information.js";

const satelliteVersion = await readReleaseVersion(
  new URL("../../../VERSION", import.meta.url),
  new URL("../package.json", import.meta.url)
);
const satellite = { id: env("SATELLITE_ID", "simulator-1") };
const audioApiPort = Number(env("AUDIO_API_PORT", "3200"));
const audioConfigPath = env("AUDIO_CONFIG_PATH", configPath("/etc/ha/satellite/audio.json", "dev/satellite/config/audio.json"));
const assistantConfigPath = env("ASSISTANT_CONFIG_PATH", configPath("/etc/ha/satellite/assistant.json", "dev/satellite/config/assistant.json"));
const satelliteServerConfigPath = env("SERVER_CONFIG_PATH", configPath("/etc/ha/satellite/server.json", "dev/satellite/config/server.json"));
const wakeWordModelsPath = env("WAKE_WORD_MODELS_PATH", configPath("/var/lib/ha/models/wake-word", "dev/satellite/models/wake-word"));
const defaultAudioConfig = { inputDeviceIds: [], inputDeviceNames: {}, inputChannelsByDevice: {}, outputDeviceIds: [], outputDeviceNames: {}, ttsVoiceId: null, musicPlayerEnabled: true, musicOutputDeviceId: null };
const audioConfigKeys = Object.keys(defaultAudioConfig).sort();
const audioDeviceProvider = createAudioDeviceProvider();
const textToSpeechProvider = createTextToSpeechProvider(jsonLog);
const sendspinPlayer = new SendspinPlayer({
  executable: env("SENDSPIN_EXECUTABLE", "sendspin"),
  satelliteId: satellite.id,
  serverUrl: env("MUSIC_ASSISTANT_SENDSPIN_URL", ""),
  log: jsonLog
});
const commandWindowMs = Number(env("WAKE_WORD_COMMAND_TIMEOUT_MS", "7000"));
const wakeWordExactMinConfidence = Number(env("WAKE_WORD_EXACT_MIN_CONFIDENCE", "0.72"));
const wakeWordEmbeddedMinConfidence = Number(env("WAKE_WORD_EMBEDDED_MIN_CONFIDENCE", "0.90"));
const serverReconnectDelayMs = Number(env("SERVER_RECONNECT_DELAY_MS", "10000"));
const wakeWordModelRefreshMs = Math.max(10_000, Number(env("WAKE_WORD_MODEL_REFRESH_MS", "60000")) || 60_000);
const postTtsWakeWordGuardMs = Math.max(0, Number(env("WAKE_WORD_POST_TTS_GUARD_MS", "1500")) || 0);
const voskOptions = {
  python: env("VOSK_PYTHON", "dev/satellite/.venv/bin/python"),
  scriptPath: env("VOSK_SCRIPT_PATH", "apps/satellite/src/voice/vosk_detector.py"),
  modelPath: env("VOSK_MODEL_PATH", "dev/satellite/models/vosk-model-small-es-0.42")
};
const openWakeWordOptions = {
  python: env("OPENWAKEWORD_PYTHON", voskOptions.python),
  scriptPath: env("OPENWAKEWORD_SCRIPT_PATH", configPath(
    "/opt/ha/current/apps/satellite/src/voice/openwakeword_detector.py",
    "apps/satellite/src/voice/openwakeword_detector.py"
  )),
  threshold: Number(env("OPENWAKEWORD_THRESHOLD", "0.995")),
  patience: Number(env("OPENWAKEWORD_PATIENCE", "2")),
  minimumAudioDb: Number(env("OPENWAKEWORD_MIN_AUDIO_DB", "-55")),
  audioActivityWindowMs: Number(env("OPENWAKEWORD_AUDIO_ACTIVITY_WINDOW_MS", "1000"))
};
let activeSocket = null;
let activeServer = null;
let reconnectTimer = null;
let connectionGeneration = 0;
let activationExpiresAt = 0;
let wakeWordDetector = null;
let wakeWordOnlyPending = false;
let pendingWakeAnnouncement = null;
let reportableFalseDetection = null;
let falseDetectionReportPending = false;
let wakeWordModelRefreshPending = false;
let pendingPositiveDetection = null;
let manualTrainingRecording = null;
let manualTrainingSessionActive = false;
let voiceCapture = null;
let microphoneMonitoringVisible = true;
const wakeActivation = new WakeActivationGate();
const commandRetry = new OneShotCommandRetry();
const outputVolumeDucker = new OutputVolumeDucker({
  readConfig: () => resolvedAudioConfig(),
  duckPercent: Number(env("VOICE_DUCK_VOLUME_PERCENT", "10")),
  log: jsonLog
});
let assistantConfig = await readAssistantConfig(assistantConfigPath, jsonLog);
const wakeWordModels = new WakeWordModelManager({
  rootPath: wakeWordModelsPath,
  serverProvider: () => activeServer,
  log: jsonLog
});
function sendspinConfig(config) {
  return { ...config, registrationName: assistantConfig.name };
}
const serverDiscovery = new ServerDiscovery({ log: jsonLog });
const serverSelection = new ServerSelection({
  discovery: serverDiscovery,
  configPath: satelliteServerConfigPath,
  log: jsonLog,
  onSelected: (server) => applySelectedServer(server)
});

function sendListeningEnded(reason) {
  activationExpiresAt = 0;
  publishLocalEvent(EventType.LISTENING_ENDED, { reason });
  if (activeSocket?.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify(createEvent(EventType.LISTENING_ENDED, { reason }, satellite.id)));
  }
}

function announceWakeListening() {
  const pending = pendingWakeAnnouncement;
  if (!pending) return;
  pendingWakeAnnouncement = null;
  void outputVolumeDucker.duck();
  const payload = {
    wakeWord: pending.name,
    timeoutMs: commandWindowMs,
    manual: false,
    reportableFalseDetection: Boolean(reportableFalseDetection)
  };
  publishLocalEvent(EventType.WAKE_WORD_DETECTED, payload);
  if (activeSocket?.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify(createEvent(EventType.WAKE_WORD_DETECTED, payload, satellite.id)));
  }
  jsonLog("info", "Wake word completada; escucha de comando iniciada", {
    provider: pending.provider,
    timeoutMs: commandWindowMs
  });
}

function handleWakeWordDetection(name, detection, provider) {
  if (manualTrainingSessionActive) {
    jsonLog("info", "Wake word ignorada durante la pantalla de entrenamiento manual", { provider });
    return;
  }
  const { audio, ...details } = detection;
  if (!wakeActivation.beginListening()) {
    jsonLog("info", "Wake word ignorada porque la sesión de voz sigue activa", { phase: wakeActivation.phase, ...details });
    return;
  }
  reportableFalseDetection = provider === "model"
    && assistantConfig.wakeWordTrainingMode === true
    && Buffer.isBuffer(audio)
    ? { modelId: assistantConfig.wakeWordModelId, audio }
    : null;
  // La detección del modelo puede ocurrir antes de que termine la wake word.
  // Primero descartamos la frase acústica completa; el display pasa a verde
  // recién cuando comienza una ventana de comando limpia.
  wakeWordOnlyPending = true;
  pendingWakeAnnouncement = { name, provider };
  commandRetry.reset();
  activationExpiresAt = Date.now() + commandWindowMs;
  voiceCapture?.arm(commandWindowMs, { bridgeAfterCurrentPhrase: true });
  jsonLog("info", "Wake word detectada; esperando que termine antes de escuchar el comando", { provider, ...details });
}

function createVoskWakeWordDetector(name) {
  return new VoskWakeWordDetector({
    ...voskOptions,
    wakeWord: name,
    cooldownMs: Number(env("WAKE_WORD_COOLDOWN_MS", "2000")),
    exactMinConfidence: wakeWordExactMinConfidence,
    embeddedMinConfidence: wakeWordEmbeddedMinConfidence,
    log: jsonLog,
    onDetected: (detection) => handleWakeWordDetection(name, detection, "vosk")
  });
}

async function createConfiguredWakeWordDetector(config) {
  if (config.wakeWordMode === "model") {
    const files = await wakeWordModels.ensureCurrent(config.wakeWordModelId, { allowCached: true });
    const detector = new OpenWakeWordDetector({
      ...openWakeWordOptions,
      ...files,
      wakeWord: files.metadata.wakeWord || config.name,
      cooldownMs: Number(env("WAKE_WORD_COOLDOWN_MS", "2000")),
      log: jsonLog,
      onDetected: (detection) => handleWakeWordDetection(files.metadata.wakeWord || config.name, detection, "model")
    });
    detector.modelSha256 = files.metadata.file.sha256;
    detector.modelModifiedAt = files.metadata.file.modifiedAt;
    return detector;
  }
  return createVoskWakeWordDetector(config.name);
}

async function refreshActiveWakeWordModel() {
  if (wakeWordModelRefreshPending
    || assistantConfig.wakeWordMode !== "model"
    || !assistantConfig.wakeWordEnabled
    || wakeActivation.phase !== "idle") return;
  wakeWordModelRefreshPending = true;
  try {
    const remote = await wakeWordModels.remoteModel(assistantConfig.wakeWordModelId);
    if (wakeWordDetector?.modelSha256 === remote.file.sha256
      && wakeWordDetector?.modelModifiedAt === remote.file.modifiedAt) return;
    await wakeWordModels.download(assistantConfig.wakeWordModelId, remote);
    await replaceWakeWordDetector(assistantConfig);
    jsonLog("info", "Modelo wake word activo actualizado automáticamente", {
      modelId: assistantConfig.wakeWordModelId,
      sha256: wakeWordDetector.modelSha256,
      modifiedAt: wakeWordDetector.modelModifiedAt
    });
  } catch (error) {
    jsonLog("warn", "No se pudo revisar la actualización del modelo wake word", {
      modelId: assistantConfig.wakeWordModelId,
      error: error.message
    });
  } finally {
    wakeWordModelRefreshPending = false;
  }
}

async function replaceWakeWordDetector(config) {
  const replacement = await createConfiguredWakeWordDetector(config);
  await replacement.start();
  const previous = wakeWordDetector;
  wakeWordDetector = replacement;
  activationExpiresAt = 0;
  wakeActivation.end();
  previous?.stop();
  jsonLog("info", "Detector de wake word iniciado", {
    mode: config.wakeWordMode,
    wakeWord: config.name,
    modelId: config.wakeWordModelId
  });
}

function stopWakeWordDetector() {
  wakeWordDetector?.stop();
  wakeWordDetector = null;
  jsonLog("info", "Detector de wake word detenido");
}

async function readAudioConfig() {
  try {
    const config = JSON.parse(await readFile(audioConfigPath, "utf8"));
    if (Object.keys(config).sort().join(",") !== audioConfigKeys.join(",")) throw new Error("La configuración de audio no cumple el contrato actual");
    if (!Array.isArray(config.inputDeviceIds) || !Array.isArray(config.outputDeviceIds)
      || !config.inputDeviceNames || !config.outputDeviceNames || !config.inputChannelsByDevice) throw new Error("La configuración de audio es inválida");
    return config;
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(defaultAudioConfig);
    throw new Error(`Configuración de audio inválida en ${audioConfigPath}: ${error.message}`);
  }
}

async function resolvedAudioConfig(config, devices) {
  config ||= await readAudioConfig();
  const listed = devices || await listAudioDevices(audioDeviceProvider, (kind, error) => jsonLog("warn", "No se pudieron resolver dispositivos de audio", { kind, error: error.message }));
  const resolve = (ids, names, available) => {
    for (const preferenceId of ids) {
      const exact = available.find((item) => item.available !== false && item.id === preferenceId);
      if (exact) return { deviceId: exact.id, preferenceId };
      const device = names[preferenceId]
        ? available.find((item) => item.available !== false && item.name === names[preferenceId])
        : null;
      if (device) return { deviceId: device.id, preferenceId };
    }
    return { deviceId: null, preferenceId: null };
  };
  const input = resolve(config.inputDeviceIds, config.inputDeviceNames, listed.input);
  const output = resolve(config.outputDeviceIds, config.outputDeviceNames, listed.output);
  return { ...config, inputDeviceId: input.deviceId, outputDeviceId: output.deviceId, inputChannel: input.preferenceId ? (config.inputChannelsByDevice[input.preferenceId] ?? 0) : 0 };
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

async function connectedServerInformation() {
  if (!activeServer?.httpUrl) return null;
  try {
    const response = await fetch(`${activeServer.httpUrl}/version`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const information = await response.json();
    return {
      id: activeServer.id,
      name: information.server?.name || activeServer.name,
      version: information.version || null,
      available: true
    };
  } catch (error) {
    jsonLog("warn", "No se pudo consultar la versión del servidor activo", { serverId: activeServer.id, error: error.message });
    return { id: activeServer.id, name: activeServer.name, version: null, available: false };
  }
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Solicitud demasiado grande");
  }
  return JSON.parse(body);
}

async function readBinaryBody(request, maximumBytes = 10_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("La grabación supera el tamaño máximo permitido");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleAudioApi(request, response) {
  if (request.method === "OPTIONS") return sendJson(response, 204, {});
  const url = new URL(request.url, "http://localhost");

  if (request.method === "GET" && url.pathname === "/identity") {
    return sendJson(response, 200, { satellite });
  }

  if (request.method === "GET" && url.pathname === "/system") {
    const [system, server] = await Promise.all([
      getSystemInformation({ satelliteVersion }),
      connectedServerInformation()
    ]);
    return sendJson(response, 200, { ...system, server });
  }

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
    return sendJson(response, 200, { config: assistantConfig, provider: assistantConfig.wakeWordMode });
  }

  if (request.method === "GET" && url.pathname === "/assistant/wake-word-models") {
    try {
      return sendJson(response, 200, {
        models: await wakeWordModels.catalog(),
        selectedModelId: assistantConfig.wakeWordModelId
      });
    } catch (error) {
      return sendJson(response, 503, {
        error: "wake_word_catalog_unavailable",
        message: error.message,
        models: []
      });
    }
  }

  const wakeWordDownloadMatch = /^\/assistant\/wake-word-models\/([a-z0-9][a-z0-9-]{0,63})\/download$/.exec(url.pathname);
  if (request.method === "POST" && wakeWordDownloadMatch) {
    try {
      const metadata = await wakeWordModels.download(wakeWordDownloadMatch[1]);
      if (assistantConfig.wakeWordEnabled
        && assistantConfig.wakeWordMode === "model"
        && assistantConfig.wakeWordModelId === wakeWordDownloadMatch[1]) {
        await replaceWakeWordDetector(assistantConfig);
      }
      return sendJson(response, 200, { metadata });
    } catch (error) {
      return sendJson(response, 422, { error: "wake_word_download_failed", message: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/assistant/wake-word-training/session/start") {
    if (wakeActivation.active) {
      return sendJson(response, 409, { error: "voice_session_active", message: "Espera a que termine la interacción de voz actual." });
    }
    manualTrainingSessionActive = true;
    stopWakeWordDetector();
    voiceCapture.start();
    return sendJson(response, 200, { active: true });
  }

  if (request.method === "POST" && url.pathname === "/assistant/wake-word-training/session/stop") {
    manualTrainingRecording = null;
    manualTrainingSessionActive = false;
    if (assistantConfig.wakeWordEnabled) {
      try {
        await replaceWakeWordDetector(assistantConfig);
      } catch (error) {
        jsonLog("warn", "No se pudo reactivar el detector al salir del entrenamiento manual", { error: error.message });
        return sendJson(response, 503, { error: "wake_word_restart_failed", message: error.message });
      }
    }
    stopCaptureWhenAutomaticWakeIsDisabled();
    return sendJson(response, 200, { active: false });
  }

  if (request.method === "POST" && url.pathname === "/assistant/wake-word-training/recordings/start") {
    if (!manualTrainingSessionActive) {
      return sendJson(response, 409, { error: "training_session_inactive", message: "Abre primero la pantalla de entrenamiento manual." });
    }
    if (manualTrainingRecording) {
      return sendJson(response, 409, { error: "training_recording_active", message: "Ya hay una grabación en curso." });
    }
    if (wakeActivation.active) {
      return sendJson(response, 409, { error: "voice_session_active", message: "Espera a que termine la interacción de voz actual." });
    }
    manualTrainingRecording = { chunks: [], bytes: 0, startedAt: Date.now() };
    voiceCapture.start();
    return sendJson(response, 202, { recording: true, maximumSeconds: 12 });
  }

  if (request.method === "POST" && url.pathname === "/assistant/wake-word-training/recordings/stop") {
    const recording = manualTrainingRecording;
    manualTrainingRecording = null;
    stopCaptureWhenAutomaticWakeIsDisabled();
    if (!recording || recording.bytes < 3_200) {
      return sendJson(response, 422, { error: "training_recording_empty", message: "La grabación es demasiado corta." });
    }
    const wav = pcmToWav(Buffer.concat(recording.chunks, recording.bytes));
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "audio/wav",
      "Content-Length": wav.length,
      "X-Recording-Duration-Ms": String(Math.round(recording.bytes / 32))
    });
    return response.end(wav);
  }

  const trainingSampleMatch = /^\/assistant\/wake-word-training\/samples\/(positive|negative)$/.exec(url.pathname);
  if (request.method === "POST" && trainingSampleMatch) {
    try {
      if (assistantConfig.wakeWordMode !== "model" || !assistantConfig.wakeWordModelId) {
        throw new Error("Selecciona y guarda primero un modelo entrenado.");
      }
      const audio = await readBinaryBody(request);
      const kind = trainingSampleMatch[1];
      const result = await wakeWordModels.addSample(
        assistantConfig.wakeWordModelId,
        kind,
        audio,
        `manual-${kind}-${satellite.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`
      );
      return sendJson(response, 201, result);
    } catch (error) {
      return sendJson(response, 422, { error: "training_sample_failed", message: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/assistant/wake-word-training/train") {
    try {
      if (assistantConfig.wakeWordMode !== "model" || !assistantConfig.wakeWordModelId) {
        throw new Error("Selecciona y guarda primero un modelo entrenado.");
      }
      return sendJson(response, 202, await wakeWordModels.train(assistantConfig.wakeWordModelId));
    } catch (error) {
      return sendJson(response, 422, { error: "training_start_failed", message: error.message });
    }
  }

  if (request.method === "PUT" && url.pathname === "/assistant") {
    try {
      const update = await readJsonBody(request);
      if ("wakeWordEnabled" in update && typeof update.wakeWordEnabled !== "boolean") {
        throw new Error("wakeWordEnabled debe ser booleano");
      }
      if ("wakeWordTrainingMode" in update && typeof update.wakeWordTrainingMode !== "boolean") {
        throw new Error("wakeWordTrainingMode debe ser booleano");
      }
      const selection = normalizeWakeWordSelection(update.wakeWordMode, update.wakeWordModelId);
      const name = selection.wakeWordMode === "vosk"
        ? await validateAssistantNameWithVosk(update.name, voskOptions)
        : normalizeAssistantName((await wakeWordModels.remoteModel(selection.wakeWordModelId)).wakeWord);
      const nextConfig = {
        name,
        wakeWordEnabled: update.wakeWordEnabled !== false,
        ...selection,
        wakeWordTrainingMode: selection.wakeWordMode === "model" && update.wakeWordTrainingMode === true,
        connectedPowerDeviceId: normalizeConnectedPowerDeviceId(update.connectedPowerDeviceId)
      };
      await applyWakeWordConfiguration(nextConfig);
      assistantConfig = nextConfig;
      await writeAssistantConfig(assistantConfigPath, assistantConfig);
      jsonLog("info", "Configuración del asistente actualizada", assistantConfig);
      return sendJson(response, 200, { config: assistantConfig, provider: assistantConfig.wakeWordMode });
    } catch (error) {
      jsonLog("warn", "Nombre del asistente rechazado", { error: error.message });
      return sendJson(response, 422, { error: "invalid_assistant_name", message: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/voice/listen") {
    try {
      const started = await startManualListening();
      if (!started) return sendJson(response, 409, { error: "voice_session_active", message: "Ya hay una sesión de voz activa." });
      return sendJson(response, 202, { listening: true, timeoutMs: commandWindowMs });
    } catch (error) {
      jsonLog("warn", "No se pudo iniciar la escucha manual", { error: error.message });
      return sendJson(response, 422, { error: "manual_listening_unavailable", message: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/voice/report-false-detection") {
    if (falseDetectionReportPending) {
      return sendJson(response, 409, { error: "false_detection_report_pending", message: "Ya se está enviando la detección falsa." });
    }
    if (wakeActivation.phase !== "listening" || !reportableFalseDetection) {
      return sendJson(response, 409, {
        error: "false_detection_unavailable",
        message: "La escucha actual no fue iniciada por un modelo entrenado o ya finalizó."
      });
    }
    const report = reportableFalseDetection;
    falseDetectionReportPending = true;
    try {
      await wakeWordModels.addNegativeSample(
        report.modelId,
        report.audio,
        `false-detection-${satellite.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`
      );
      activationExpiresAt = 0;
      wakeWordOnlyPending = false;
      pendingWakeAnnouncement = null;
      reportableFalseDetection = null;
      commandRetry.clear();
      voiceCapture.disarm();
      wakeActivation.end();
      await outputVolumeDucker.restore();
      sendListeningEnded("false_detection_reported");
      stopCaptureWhenAutomaticWakeIsDisabled();
      jsonLog("info", "Detección falsa reportada como muestra negativa", {
        modelId: report.modelId,
        audioBytes: report.audio.length
      });
      return sendJson(response, 201, { reported: true, modelId: report.modelId });
    } catch (error) {
      jsonLog("warn", "No se pudo reportar la detección falsa", { modelId: report.modelId, error: error.message });
      return sendJson(response, 502, { error: "false_detection_report_failed", message: error.message });
    } finally {
      falseDetectionReportPending = false;
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
    const effectiveConfig = await resolvedAudioConfig(config, devices);
    return sendJson(response, 200, {
      config,
      effectiveConfig,
      devices: { input: devices.input, output: devices.output },
      voices,
      provider: devices.provider,
      ttsProvider: textToSpeechProvider.name,
      musicPlayer: sendspinPlayer.status(config)
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
      const allowedUpdateKeys = ["inputDeviceId", "outputDeviceId", "inputChannel", "ttsVoiceId", "musicPlayerEnabled", "musicOutputDeviceId"];
      const unknownKeys = Object.keys(update).filter((key) => !allowedUpdateKeys.includes(key));
      if (unknownKeys.length) throw new Error(`Campos de audio desconocidos: ${unknownKeys.join(", ")}`);
      const config = await readAudioConfig();
      const currentDevices = await listAudioDevices(audioDeviceProvider, () => {});
      const previousInputDeviceId = config.inputDeviceIds[0] || null;
      for (const key of ["musicOutputDeviceId"]) {
        if (key in update && update[key] !== null && typeof update[key] !== "string") throw new Error(`Valor inválido: ${key}`);
        if (key in update) config[key] = update[key];
      }
      for (const [key, listKey] of [["inputDeviceId", "inputDeviceIds"], ["outputDeviceId", "outputDeviceIds"]]) {
        if (!(key in update)) continue;
        if (update[key] !== null && typeof update[key] !== "string") throw new Error(`Valor inválido: ${key}`);
        config[listKey] = update[key] ? [update[key], ...config[listKey].filter((id) => id !== update[key])] : [];
        const kind = key === "inputDeviceId" ? "input" : "output";
        const namesKey = key === "inputDeviceId" ? "inputDeviceNames" : "outputDeviceNames";
        const selected = currentDevices[kind].find((device) => device.id === update[key]);
        if (selected) config[namesKey][update[key]] = selected.name;
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
      const selectedInputDeviceId = config.inputDeviceIds[0] || null;
      if (Number.isInteger(update.inputChannel)) {
        if (!selectedInputDeviceId) throw new Error("Selecciona primero un dispositivo de entrada");
        const channels = await audioDeviceProvider.listInputChannels(selectedInputDeviceId);
        if (!channels.some((channel) => channel.id === update.inputChannel)) throw new Error("El canal no existe en el dispositivo seleccionado");
      }
      if ("inputChannel" in update) {
        if (selectedInputDeviceId) config.inputChannelsByDevice[selectedInputDeviceId] = update.inputChannel;
      } else if ("inputDeviceId" in update && update.inputDeviceId !== previousInputDeviceId && selectedInputDeviceId
        && config.inputChannelsByDevice[selectedInputDeviceId] === undefined) {
        config.inputChannelsByDevice[selectedInputDeviceId] = 0;
      }
      if ("musicPlayerEnabled" in update) config.musicPlayerEnabled = Boolean(update.musicPlayerEnabled);
      await writeAudioConfig(config);
      if (["musicPlayerEnabled", "musicOutputDeviceId"].some((key) => key in update)) await sendspinPlayer.start(sendspinConfig(config));
      if (["ttsVoiceId", "outputDeviceId"].some((key) => key in update)) {
        const effective = await resolvedAudioConfig(config, currentDevices);
        const voices = await textToSpeechProvider.listVoices();
        const voiceId = voices.some((voice) => voice.id === effective.ttsVoiceId) ? effective.ttsVoiceId : voices[0]?.id;
        if (effective.outputDeviceId && voiceId) {
          void textToSpeechProvider.prepare?.(voiceId, effective.outputDeviceId)
            .catch((error) => jsonLog("warn", "No se pudo precargar la voz Piper", { voiceId, error: error.message }));
        } else textToSpeechProvider.stop?.();
      }
      jsonLog("info", "Configuración de audio actualizada", config);
      return sendJson(response, 200, { config, effectiveConfig: await resolvedAudioConfig(config, currentDevices) });
    } catch (error) {
      return sendJson(response, 400, { error: "invalid_audio_config", message: error.message });
    }
  }

  return sendJson(response, 404, { error: "not_found" });
}

const localApiServer = createServer((request, response) => {
  handleAudioApi(request, response).catch((error) => {
    jsonLog("warn", "Error en API de audio", { error: error.message });
    sendJson(response, 500, { error: "internal_error" });
  });
});
const localEvents = new WebSocketServer({ server: localApiServer, path: "/events" });
localEvents.on("connection", (socket) => {
  jsonLog("info", "Display conectado a eventos locales");
  socket.send(JSON.stringify(createEvent(EventType.MICROPHONE_MONITORING_CHANGED, {
    visible: microphoneMonitoringVisible
  }, satellite.id)));
  socket.on("error", (error) => jsonLog("warn", "Error en WebSocket local", { error: error.message }));
});
function publishLocalEvent(type, payload) {
  const encoded = JSON.stringify(createEvent(type, payload, satellite.id));
  for (const client of localEvents.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(encoded);
  }
}

function setMicrophoneMonitoringVisible(visible) {
  if (microphoneMonitoringVisible === visible) return;
  microphoneMonitoringVisible = visible;
  publishLocalEvent(EventType.MICROPHONE_MONITORING_CHANGED, { visible });
}

function stopCaptureWhenAutomaticWakeIsDisabled() {
  if (!assistantConfig.wakeWordEnabled && !manualTrainingSessionActive && wakeActivation.phase === "idle") {
    voiceCapture?.stop();
    publishLocalEvent(EventType.AUDIO_LEVEL_UPDATED, { db: -60, level: 0, clipping: false });
    jsonLog("info", "Captura continua detenida porque la wake word está desactivada");
  }
}

async function applyWakeWordConfiguration(config) {
  if (config.wakeWordEnabled) {
    await replaceWakeWordDetector(config);
    voiceCapture?.start();
    return;
  }
  stopWakeWordDetector();
  if (wakeActivation.phase === "idle") voiceCapture?.stop();
}

async function startManualListening() {
  if (!wakeActivation.beginListening()) return false;
  const bridgeCurrentPhrase = voiceCapture?.running === true;
  reportableFalseDetection = null;
  wakeWordOnlyPending = false;
  pendingWakeAnnouncement = null;
  commandRetry.clear();
  activationExpiresAt = Date.now() + commandWindowMs;
  voiceCapture.arm(commandWindowMs, { bridgeCurrentPhrase });
  voiceCapture.start();
  const payload = { wakeWord: assistantConfig.name, timeoutMs: commandWindowMs, manual: true };
  publishLocalEvent(EventType.WAKE_WORD_DETECTED, payload);
  if (activeSocket?.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify(createEvent(EventType.WAKE_WORD_DETECTED, payload, satellite.id)));
  }
  void outputVolumeDucker.duck();
  jsonLog("info", "Escucha manual iniciada", { timeoutMs: commandWindowMs, bridgeCurrentPhrase });
  return true;
}

localApiServer.listen(audioApiPort, "0.0.0.0", () => jsonLog("info", "API y eventos locales iniciados", { port: audioApiPort }));

voiceCapture = new VoiceCapture({
  readConfig: resolvedAudioConfig,
  log: jsonLog,
  silenceDuration: Number(env("VOICE_SILENCE_DURATION_MS", "800")) / 1000,
  maxPhraseSeconds: Number(env("VOICE_MAX_PHRASE_SECONDS", "8")),
  noiseFloorDb: Number(env("VOICE_INITIAL_NOISE_FLOOR_DB", "-50")),
  speechStartMarginDb: Number(env("VOICE_SPEECH_START_MARGIN_DB", "10")),
  speechEndMarginDb: Number(env("VOICE_SPEECH_END_MARGIN_DB", "6")),
  commandSpeechStartMarginDb: Number(env("VOICE_COMMAND_SPEECH_START_MARGIN_DB", "6")),
  commandMinimumSpeechMs: Number(env("VOICE_COMMAND_MINIMUM_SPEECH_MS", "100")),
  preRollMs: Number(env("VOICE_COMMAND_PRE_ROLL_MS", "400")),
  onCommandWindowStarted: (timeoutMs) => {
    activationExpiresAt = Date.now() + timeoutMs;
    announceWakeListening();
  },
  onAudio: (audio) => {
    if (manualTrainingRecording) {
      const maximumBytes = 12 * 32_000;
      const remaining = maximumBytes - manualTrainingRecording.bytes;
      if (remaining > 0) {
        const chunk = audio.subarray(0, remaining);
        manualTrainingRecording.chunks.push(Buffer.from(chunk));
        manualTrainingRecording.bytes += chunk.length;
      }
      return;
    }
    if (!wakeActivation.active) wakeWordDetector?.write(audio);
  },
  onListeningTimeout: async () => {
    wakeWordOnlyPending = false;
    pendingWakeAnnouncement = null;
    commandRetry.clear();
    wakeActivation.end();
    await outputVolumeDucker.restore();
    jsonLog("info", "Ventana de voz terminada sin comando");
    sendListeningEnded("timeout");
    stopCaptureWhenAutomaticWakeIsDisabled();
  },
  onCaptureError: async () => {
    if (activationExpiresAt || wakeActivation.active) {
      wakeWordOnlyPending = false;
      pendingWakeAnnouncement = null;
      commandRetry.clear();
      activationExpiresAt = 0;
      wakeActivation.end();
      await outputVolumeDucker.restore();
      sendListeningEnded("capture_error");
      stopCaptureWhenAutomaticWakeIsDisabled();
    }
  },
  onLevel: (level) => {
    publishLocalEvent(EventType.AUDIO_LEVEL_UPDATED, level);
  },
  onPhrase: async (audio, { commandWasArmed = false, bridgedCommand = false } = {}) => {
    if (manualTrainingRecording) return;
    // Sin detector local no existe fallback remoto: nunca enviamos audio
    // ambiental al servidor. Toda solicitud STT nace de una sesión local armada.
    const locallyActivated = wakeActivation.active && (commandWasArmed || Date.now() <= activationExpiresAt);
    if (!locallyActivated) return;
    if (wakeWordOnlyPending && !bridgedCommand) {
      wakeWordOnlyPending = false;
      commandRetry.consume();
      activationExpiresAt = Date.now() + commandWindowMs;
      voiceCapture.arm(commandWindowMs);
      announceWakeListening();
      jsonLog("info", "Frase de wake word descartada; iniciando ventana completa para el comando", { timeoutMs: commandWindowMs });
      return;
    }
    const activationWasWakeWordOnly = wakeWordOnlyPending;
    if (!activationWasWakeWordOnly) await outputVolumeDucker.restore();
    wakeActivation.beginProcessing();
    // La ventana se consume antes de llamar al STT: nunca puede procesar más de
    // una frase ni ser extendida por ruido mientras la solicitud está en curso.
    activationExpiresAt = 0;
    wakeWordOnlyPending = false;
    pendingWakeAnnouncement = null;
    sendListeningEnded("captured");
    setMicrophoneMonitoringVisible(false);
    const trainingDetection = reportableFalseDetection && assistantConfig.wakeWordTrainingMode === true
      ? reportableFalseDetection
      : null;
    const activationId = trainingDetection ? crypto.randomUUID() : null;
    pendingPositiveDetection = trainingDetection ? { ...trainingDetection, activationId } : null;
    try {
      if (!activeServer) throw new Error("No hay un servidor del asistente seleccionado y disponible");
      const response = await fetch(activeServer.speechToTextUrl, {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          "X-Satellite-Id": satellite.id,
          "X-Assistant-Name": assistantConfig.name,
          "X-Connected-Power-Device-Id": assistantConfig.connectedPowerDeviceId || "",
          "X-Voice-Activation-Id": activationId || ""
        },
        body: audio
      });
      if (!response.ok) throw new Error(`STT respondió HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const result = await response.json();
      if (!result.accepted && pendingPositiveDetection?.activationId === activationId) pendingPositiveDetection = null;
      if (result.accepted) reportableFalseDetection = null;
      if (result.awaitingCommand) {
        if (commandRetry.consume()) {
          await outputVolumeDucker.duck();
          activationExpiresAt = Date.now() + commandWindowMs;
          wakeActivation.keepListening();
          voiceCapture.arm(commandWindowMs);
          setMicrophoneMonitoringVisible(true);
          if (activeSocket?.readyState === WebSocket.OPEN) {
            activeSocket.send(JSON.stringify(createEvent(EventType.FOLLOW_UP_LISTENING_STARTED, {
              timeoutMs: commandWindowMs,
              reason: "wake_word_only"
            }, satellite.id)));
          }
          jsonLog("info", "Audio activado sin comando; esperando una única frase local", { timeoutMs: commandWindowMs });
        } else {
          await outputVolumeDucker.restore();
          activationExpiresAt = 0;
          wakeActivation.end();
          voiceCapture.disarm();
          setMicrophoneMonitoringVisible(true);
          sendListeningEnded("no_command");
          jsonLog("info", "Sesión terminada después de una frase adicional sin comando");
          stopCaptureWhenAutomaticWakeIsDisabled();
        }
      }
      jsonLog("info", result.accepted ? "Comando local transcrito" : "Frase local ignorada", {
        transcript: result.transcript,
        assistantName: result.assistantName
      });
      if (!result.awaitingCommand) {
        if (activationWasWakeWordOnly) await outputVolumeDucker.restore();
        commandRetry.clear();
        if (!result.accepted) {
          wakeActivation.end();
          setMicrophoneMonitoringVisible(true);
          stopCaptureWhenAutomaticWakeIsDisabled();
        }
      }
    } catch (error) {
      if (pendingPositiveDetection?.activationId === activationId) pendingPositiveDetection = null;
      await outputVolumeDucker.restore().catch(() => {});
      commandRetry.clear();
      wakeActivation.end();
      setMicrophoneMonitoringVisible(true);
      stopCaptureWhenAutomaticWakeIsDisabled();
      throw error;
    }
  }
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let speechQueue = Promise.resolve();

async function finishProcessingWithoutSpeech() {
  if (wakeActivation.phase !== "processing") return;
  await wakeWordDetector?.reset?.();
  wakeActivation.end();
  setMicrophoneMonitoringVisible(true);
  stopCaptureWhenAutomaticWakeIsDisabled();
  jsonLog("info", "Detector reactivado después de una respuesta sin TTS");
}

async function cancelListeningForSpeech() {
  const wasListening = activationExpiresAt > 0 || wakeActivation.phase === "listening";
  activationExpiresAt = 0;
  wakeWordOnlyPending = false;
  pendingWakeAnnouncement = null;
  commandRetry.clear();
  voiceCapture.disarm();
  if (wakeActivation.phase === "listening") wakeActivation.end();
  if (!wasListening) return;
  await outputVolumeDucker.restore().catch((error) => {
    jsonLog("warn", "No se pudo restaurar el volumen al interrumpir la escucha", { error: error.message });
  });
  sendListeningEnded("interrupted_by_speech");
  jsonLog("info", "Escucha cancelada por una respuesta TTS entrante");
  stopCaptureWhenAutomaticWakeIsDisabled();
}

function openFollowUpWindow(timeoutMs) {
  wakeActivation.end();
  wakeActivation.beginListening();
  activationExpiresAt = Date.now() + timeoutMs;
  voiceCapture.arm(timeoutMs);
  voiceCapture.start();
  void outputVolumeDucker.duck();
  if (activeSocket?.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify(createEvent(EventType.FOLLOW_UP_LISTENING_STARTED, { timeoutMs }, satellite.id)));
  }
  jsonLog("info", "Ventana de seguimiento abierta", { timeoutMs });
}

function enqueueSpeech(text, { expectsReply = false, followUpTimeoutMs = 5000 } = {}) {
  speechQueue = speechQueue.then(async () => {
    setMicrophoneMonitoringVisible(false);
    await cancelListeningForSpeech();
    if (wakeActivation.phase === "idle") wakeActivation.beginListening();
    wakeActivation.beginProcessing();
    const config = await resolvedAudioConfig();
    if (!config.outputDeviceId) {
      jsonLog("info", "Respuesta TTS omitida: no hay salida configurada");
      await wakeWordDetector?.reset?.();
      wakeActivation.end();
      if (expectsReply) openFollowUpWindow(followUpTimeoutMs);
      setMicrophoneMonitoringVisible(true);
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
      await wakeWordDetector?.reset?.();
      if (expectsReply) {
        voiceCapture.resume();
        openFollowUpWindow(followUpTimeoutMs);
      } else {
        if (postTtsWakeWordGuardMs) {
          jsonLog("info", "Guarda post-TTS antes de reactivar wake word", { timeoutMs: postTtsWakeWordGuardMs });
          await delay(postTtsWakeWordGuardMs);
        }
        voiceCapture.resume();
        wakeActivation.end();
        stopCaptureWhenAutomaticWakeIsDisabled();
      }
      setMicrophoneMonitoringVisible(true);
    }
  }).catch((error) => {
    setMicrophoneMonitoringVisible(true);
    wakeActivation.end();
    jsonLog("warn", "No se pudo reproducir la respuesta TTS", { error: error.message });
  });
}

await serverSelection.start();
const initialAudioConfig = await readAudioConfig();
const initialEffectiveAudioConfig = await resolvedAudioConfig(initialAudioConfig);
const initialVoices = await textToSpeechProvider.listVoices().catch(() => []);
const initialVoiceId = initialVoices.some((voice) => voice.id === initialEffectiveAudioConfig.ttsVoiceId)
  ? initialEffectiveAudioConfig.ttsVoiceId
  : initialVoices[0]?.id;
if (initialEffectiveAudioConfig.outputDeviceId && initialVoiceId) {
  void textToSpeechProvider.prepare?.(initialVoiceId, initialEffectiveAudioConfig.outputDeviceId)
    .then(() => jsonLog("info", "Voz Piper precargada", { voiceId: initialVoiceId }))
    .catch((error) => jsonLog("warn", "No se pudo precargar la voz Piper", { voiceId: initialVoiceId, error: error.message }));
}
try {
  await applyWakeWordConfiguration(assistantConfig);
} catch (error) {
  stopWakeWordDetector();
  voiceCapture.stop();
  assistantConfig = { ...assistantConfig, wakeWordEnabled: false };
  jsonLog("warn", "No se pudo iniciar el detector automático; la activación manual continúa disponible", { error: error.message });
}
await sendspinPlayer.start(sendspinConfig(initialAudioConfig)).catch((error) => jsonLog("warn", "El parlante Sendspin no pudo iniciarse automáticamente", { error: error.message }));
const wakeWordModelRefresh = setInterval(() => void refreshActiveWakeWordModel(), wakeWordModelRefreshMs);
wakeWordModelRefresh.unref();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void outputVolumeDucker.restore();
    clearTimeout(reconnectTimer);
    clearInterval(wakeWordModelRefresh);
    serverSelection.stop();
    activeSocket?.close();
    voiceCapture.stop();
    wakeWordDetector?.stop();
    textToSpeechProvider.stop?.();
    sendspinPlayer.stop();
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
  }, serverReconnectDelayMs);
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
      if (!isEvent(event)) throw new Error("Evento incompatible con el protocolo actual");
      jsonLog("info", "Evento para el satélite", { type: event.type, source: event.source });
      if (event.type === EventType.ASSISTANT_RESPONSE
        && event.payload.targetSatelliteId === satellite.id
        && event.payload.activationId
        && pendingPositiveDetection?.activationId === event.payload.activationId) {
        const positive = pendingPositiveDetection;
        pendingPositiveDetection = null;
        if (event.payload.commandProcessed === true) {
          void wakeWordModels.addPositiveSample(
            positive.modelId,
            positive.audio,
            `accepted-detection-${satellite.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`
          ).then(() => jsonLog("info", "Activación confirmada enviada como muestra positiva", {
            modelId: positive.modelId,
            audioBytes: positive.audio.length
          })).catch((error) => jsonLog("warn", "No se pudo enviar la activación positiva", {
            modelId: positive.modelId,
            error: error.message
          }));
        } else {
          jsonLog("info", "Activación no guardada: el comando no pudo procesarse correctamente", {
            modelId: positive.modelId
          });
        }
      }
      if (event.type === EventType.ASSISTANT_RESPONSE
        && event.payload.targetSatelliteId === satellite.id
        && event.payload.speechRequested === false) {
        void finishProcessingWithoutSpeech();
      }
      if (event.type === EventType.ASSISTANT_SPEECH_REQUESTED
        && event.payload.targetSatelliteId === satellite.id
        && typeof event.payload.text === "string"
        && event.payload.text.trim()) {
        enqueueSpeech(event.payload.text.trim(), {
          expectsReply: event.payload.expectsReply === true,
          followUpTimeoutMs: Number.isFinite(event.payload.followUpTimeoutMs)
            ? Math.max(1000, event.payload.followUpTimeoutMs)
            : 8000
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
