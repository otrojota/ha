import { createServer } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createEvent, EventType, isEvent, PROTOCOL_VERSION } from "@ha/contracts";
import { configPath, env, jsonLog, readReleaseVersion } from "@ha/shared";
import { WhisperServerSpeechToText } from "./speech/whisper-server-speech-to-text.js";
import { isAssistantNameOnly, isMeaningfulVoiceCommand } from "./speech/voice-command.js";
import { AssistantAgent } from "./agent/assistant-agent.js";
import { createLlmClient, LlmClientManager, testLlmClient } from "./agent/llm-client-manager.js";
import { ToolRegistry } from "./agent/tool-registry.js";
import { getIdentityTool } from "./tools/assistant/get-identity.tool.js";
import { getCurrentDateTimeTool } from "./tools/datetime/get-current-datetime.tool.js";
import { getDateInfoTool } from "./tools/datetime/get-date-info.tool.js";
import { getDateDifferenceTool } from "./tools/datetime/get-date-difference.tool.js";
import { readServerConfig, validateHomeAssistantConfig, validateLlmConfig, validateLocation, writeServerConfig } from "./config/server-config.js";
import { readServerSecrets, writeServerSecrets } from "./config/server-secrets.js";
import { SearxngWebSearchProvider } from "./web/searxng-web-search-provider.js";
import { ReadableWebContentExtractor } from "./web/readable-web-content-extractor.js";
import { createSearchAndReadTool } from "./tools/web/search-and-read.tool.js";
import { ConversationMemory } from "./agent/conversation-memory.js";
import { isConversationResetCommand } from "./speech/conversation-command.js";
import { getConfiguredLocationTool } from "./tools/location/get-configured-location.tool.js";
import { IpLocationProvider } from "./location/ip-location-provider.js";
import { AlarmScheduler } from "./alarms/alarm-scheduler.js";
import { alarmMessage, createSetAlarmTool } from "./tools/alarm/set-alarm.tool.js";
import { createListAlarmsTool } from "./tools/alarm/list-alarms.tool.js";
import { createCancelAlarmTool } from "./tools/alarm/cancel-alarm.tool.js";
import { createGetAlarmRemainingTool } from "./tools/alarm/get-alarm-remaining.tool.js";
import { removeGenericFollowUp, responseExpectsReply } from "./speech/assistant-response.js";
import { OpenMeteoWeatherProvider } from "./weather/open-meteo-weather-provider.js";
import { createGetCurrentWeatherTool } from "./tools/weather/get-current-weather.tool.js";
import { createGetWeatherForecastTool } from "./tools/weather/get-weather-forecast.tool.js";
import { MusicGatewayClient } from "./music/music-gateway-client.js";
import { createListMusicDestinationsTool } from "./tools/music/list-destinations.tool.js";
import { createSetActiveMusicDestinationTool } from "./tools/music/set-active-destination.tool.js";
import { createPlayMusicTool } from "./tools/music/play-music.tool.js";
import { createPauseMusicTool } from "./tools/music/pause-music.tool.js";
import { createGetMusicPlaybackTool } from "./tools/music/get-playback.tool.js";
import { createResumeMusicTool } from "./tools/music/resume-music.tool.js";
import { createNextMusicTool } from "./tools/music/next-music.tool.js";
import { createPreviousMusicTool } from "./tools/music/previous-music.tool.js";
import { createSetMusicVolumeTool } from "./tools/music/set-volume.tool.js";
import { createAddToMusicQueueTool } from "./tools/music/add-to-queue.tool.js";
import { createTransferMusicPlaybackTool } from "./tools/music/transfer-playback.tool.js";
import { createGetMusicQueueTool } from "./tools/music/get-queue.tool.js";
import { createGetCurrentMusicCreditsTool } from "./tools/music/get-current-credits.tool.js";
import { createClearMusicQueueTool } from "./tools/music/clear-queue.tool.js";
import { createListMusicSourcesTool } from "./tools/music/list-sources.tool.js";
import { createSetActiveMusicSourceTool } from "./tools/music/set-active-source.tool.js";
import { createListLibraryRadiosTool } from "./tools/music/list-library-radios.tool.js";
import { createListLibraryPlaylistsTool } from "./tools/music/list-library-playlists.tool.js";
import { readOrCreateServerIdentity } from "./config/server-identity.js";
import { DeviceGatewayRegistry } from "./home-automation/device-gateway-registry.js";
import { HomeAutomationService } from "./home-automation/home-automation-service.js";
import { createHomeLightTools } from "./tools/home/light-tools.js";
import { createHomeAssistantDeviceTools } from "./tools/home/home-assistant-device-tools.js";
import { HomeAssistantClient } from "./home-automation/home-assistant-client.js";
import { HomeAssistantRgbBulbGateway } from "./home-automation/home-assistant-rgb-bulb-gateway.js";
import { HomeAssistantCatalog } from "./home-automation/home-assistant-catalog.js";
import { ScheduledAutomationExecutor } from "./automations/scheduled-automation-executor.js";
import { createScheduleAutomationTool } from "./tools/automation/schedule-automation.tool.js";
import { createStreamingTtsProvider } from "./tts/index.js";
import { VoiceConfigStore } from "./tts/voice-config-store.js";
import { SatelliteSocketRegistry } from "./tts/satellite-socket-registry.js";
import { TtsStreamService } from "./tts/tts-stream-service.js";
import { VoiceInputSessionRegistry } from "./voice/voice-input-session.js";
import { VoiceStateCoordinator } from "./voice/voice-state-coordinator.js";
import { ContinuousVoiceRecognitionService } from "./voice/continuous-voice-recognition.js";
import { createDisplayStaticHandler, defaultDisplayDirectory } from "./http/display-static.js";
import { createMusicGatewayProxy } from "./http/music-gateway-proxy.js";

const port = Number(env("SERVER_PORT", "3000"));
const serverVersion = await readReleaseVersion(
  new URL("../../../VERSION", import.meta.url),
  new URL("../package.json", import.meta.url)
);
const serverConfigPath = env("SERVER_CONFIG_PATH", configPath("/etc/ha/server/server.json", "dev/server/config/server.json"));
const serverSecretsPath = env("SERVER_SECRETS_PATH", configPath("/etc/ha/server/secrets.json", "dev/server/config/secrets.json"));
const serverHostName = hostname().replace(/\.local$/i, "");
const serverIdentity = await readOrCreateServerIdentity(
  env("SERVER_IDENTITY_PATH", configPath(`/etc/ha/server/identity-${serverHostName}.json`, `dev/server/config/identity-${serverHostName}.json`)),
  { name: env("SERVER_NAME", `Servidor ${serverHostName}`), log: jsonLog }
);
const serveDisplay = createDisplayStaticHandler({
  directory: env("DISPLAY_PUBLIC_PATH", defaultDisplayDirectory)
});
const defaultAssistantName = "Asistente";
const followUpTimeoutMs = Number(env("FOLLOW_UP_TIMEOUT_MS", "8000"));
const serverConfig = await readServerConfig(serverConfigPath, jsonLog);
const serverSecrets = await readServerSecrets(serverSecretsPath, jsonLog);
const homeAssistantGateway = new HomeAssistantRgbBulbGateway();
const deviceGateways = new DeviceGatewayRegistry([homeAssistantGateway]);
function createHomeAssistantClient(config = serverConfig.homeAutomation.homeAssistant, secret = serverSecrets.homeAssistant) {
  if (!config.enabled || !secret?.token) return null;
  return new HomeAssistantClient({ ...config, token: secret.token });
}
const homeAssistantCatalog = new HomeAssistantCatalog({ clientProvider: createHomeAssistantClient, log: jsonLog });
homeAssistantGateway.setClient(createHomeAssistantClient());
await homeAssistantCatalog.refresh();
const baseAssistantContext = {
  assistantPurpose: env("ASSISTANT_PURPOSE", "Ayudar mediante voz y coordinar herramientas domésticas."),
  locale: serverConfig.locale,
  timeZone: serverConfig.timeZone
};
const tools = [
  getIdentityTool,
  getCurrentDateTimeTool,
  getDateInfoTool,
  getDateDifferenceTool,
  getConfiguredLocationTool
];
const homeAutomation = new HomeAutomationService({ store: homeAssistantCatalog, gateways: deviceGateways });
const homeLightTools = createHomeLightTools({ home: homeAutomation });
tools.push(...homeLightTools);
tools.push(...createHomeAssistantDeviceTools({
  home: homeAutomation,
  clientProvider: createHomeAssistantClient,
  refresh: () => homeAssistantCatalog.refresh()
}));
const ipLocationProvider = new IpLocationProvider();
const weatherProvider = new OpenMeteoWeatherProvider();
tools.push(createGetCurrentWeatherTool({ provider: weatherProvider }));
tools.push(createGetWeatherForecastTool({ provider: weatherProvider }));
if (serverConfig.webSearch.enabled) {
  tools.push(createSearchAndReadTool({
    searchProvider: new SearxngWebSearchProvider({ baseUrl: serverConfig.webSearch.searxngUrl }),
    contentExtractor: new ReadableWebContentExtractor({ maxCharacters: serverConfig.webSearch.maxContentCharacters }),
    maxResultsToTry: serverConfig.webSearch.maxResultsToTry,
    log: jsonLog
  }));
}
const musicGatewayBaseUrl = env("MUSIC_GATEWAY_URL", "http://localhost:3100");
const musicGatewayTimeoutMs = Number(env("MUSIC_GATEWAY_TIMEOUT_MS", "90000"));
const musicGateway = new MusicGatewayClient({ baseUrl: musicGatewayBaseUrl, timeoutMs: musicGatewayTimeoutMs });
const proxyMusicGateway = createMusicGatewayProxy({ baseUrl: musicGatewayBaseUrl, timeoutMs: musicGatewayTimeoutMs });
let scheduledAutomationExecutor;
const alarmScheduler = new AlarmScheduler({
  storagePath: env("ALARM_CONFIG_PATH", configPath("/etc/ha/server/alarms.json", "dev/server/config/alarms.json")),
  log: jsonLog,
  onFire: async (alarm) => {
    if (alarm.kind !== "automation") return publishAssistantResponse(alarmMessage(alarm.kind, alarm.label), alarm.satelliteId);
    const result = await scheduledAutomationExecutor.execute(alarm);
    if (alarm.announce) publishAssistantResponse(result.success ? `Automatización ejecutada${alarm.label ? `: ${alarm.label}` : ""}.` : `La automatización terminó con errores${alarm.label ? `: ${alarm.label}` : ""}.`, alarm.satelliteId);
  }
});
tools.push(createSetAlarmTool({ scheduler: alarmScheduler }));
tools.push(createListAlarmsTool({ scheduler: alarmScheduler }));
tools.push(createCancelAlarmTool({ scheduler: alarmScheduler }));
tools.push(createGetAlarmRemainingTool({ scheduler: alarmScheduler }));
tools.push(createScheduleAutomationTool({ scheduler: alarmScheduler, homeEnabled: serverConfig.homeAutomation.homeAssistant.enabled }));
tools.push(createListMusicDestinationsTool({ music: musicGateway }));
tools.push(createListMusicSourcesTool({ music: musicGateway }));
tools.push(createListLibraryRadiosTool({ music: musicGateway }));
tools.push(createListLibraryPlaylistsTool({ music: musicGateway }));
tools.push(createSetActiveMusicSourceTool({ music: musicGateway }));
tools.push(createSetActiveMusicDestinationTool({ music: musicGateway }));
tools.push(createPlayMusicTool({ music: musicGateway }));
tools.push(createPauseMusicTool({ music: musicGateway }));
tools.push(createGetMusicPlaybackTool({ music: musicGateway }));
tools.push(createResumeMusicTool({ music: musicGateway }));
tools.push(createNextMusicTool({ music: musicGateway }));
tools.push(createPreviousMusicTool({ music: musicGateway }));
tools.push(createSetMusicVolumeTool({ music: musicGateway }));
tools.push(createAddToMusicQueueTool({ music: musicGateway }));
tools.push(createTransferMusicPlaybackTool({ music: musicGateway }));
tools.push(createGetMusicQueueTool({ music: musicGateway }));
tools.push(createGetCurrentMusicCreditsTool({ music: musicGateway }));
tools.push(createClearMusicQueueTool({ music: musicGateway }));
const toolRegistry = new ToolRegistry(tools);
scheduledAutomationExecutor = new ScheduledAutomationExecutor({
  home: homeAutomation,
  music: musicGateway,
  executeTool: (name, args, context) => toolRegistry.execute(name, args, context),
  log: jsonLog
});
await alarmScheduler.start();
const llmClientManager = new LlmClientManager(createLlmClient(serverConfig.llm, serverSecrets.llm[serverConfig.llm.provider]));
const assistantAgent = new AssistantAgent({
  client: llmClientManager,
  tools: toolRegistry,
  log: jsonLog
});
const conversationMemory = new ConversationMemory(serverConfig.conversationMemory);
const memoryCleanup = setInterval(() => conversationMemory.cleanup(), 60_000);
memoryCleanup.unref();
const whisperModel = env("WHISPER_MODEL", "large-v3");
const whisperModelDirectory = env("WHISPER_MODEL_DIR", configPath("/var/lib/ha/models/whisper", "dev/server/models"));
const speechToText = new WhisperServerSpeechToText({
  executable: env("WHISPER_SERVER_CLI", "whisper-server"),
  modelPath: env("WHISPER_MODEL_PATH", join(whisperModelDirectory, `ggml-${whisperModel}.bin`)),
  language: env("WHISPER_LANGUAGE", "es"),
  noGpu: env("WHISPER_NO_GPU", "false") === "true",
  threads: Number(env("WHISPER_THREADS", "4")),
  bestOf: Number(env("WHISPER_BEST_OF", "2")),
  host: env("WHISPER_SERVER_HOST", "127.0.0.1"),
  port: Number(env("WHISPER_SERVER_PORT", "8178")),
  startupTimeoutMs: Number(env("WHISPER_SERVER_STARTUP_TIMEOUT_MS", "120000")),
  requestTimeoutMs: Number(env("WHISPER_SERVER_REQUEST_TIMEOUT_MS", "120000")),
  managed: env("WHISPER_SERVER_MANAGED", "true") === "true",
  log: jsonLog
});
await speechToText.initialize();
const streamingTtsProvider = createStreamingTtsProvider({ log: jsonLog });
await streamingTtsProvider.initialize?.();
const voiceConfig = new VoiceConfigStore({
  path: env("TTS_CONFIG_PATH", configPath("/etc/ha/server/tts.json", "dev/server/config/tts.json")),
  log: jsonLog
});
await voiceConfig.initialize();
const satelliteSockets = new SatelliteSocketRegistry();
const voiceInputSessions = new VoiceInputSessionRegistry({
  log: jsonLog,
  ringBufferMs: Number(env("VOICE_INPUT_RING_BUFFER_MS", "3000")),
  discontinuityMs: Number(env("VOICE_INPUT_DISCONTINUITY_MS", "250"))
});
const voiceListeningTimeoutMs = Number(env("VOICE_STATE_LISTENING_TIMEOUT_MS", "7000"));
const satelliteVoiceConfigs = new Map();
const centralCommandAttempts = new Map();
const voiceStates = new VoiceStateCoordinator({
  sessions: voiceInputSessions,
  publish: (payload) => broadcast(createEvent(EventType.VOICE_STATE_CHANGED, payload, "server")),
  requestListening: (satelliteId, payload) => {
    const socket = satelliteSockets.get(satelliteId);
    if (!socket) throw new Error(`El satélite ${satelliteId} no está conectado para escuchar`);
    socket.send(JSON.stringify(createEvent(EventType.VOICE_LISTEN_REQUESTED, {
      ...payload,
      targetSatelliteId: satelliteId
    }, "server")));
  },
  log: jsonLog
});
const ttsStreams = new TtsStreamService({
  provider: streamingTtsProvider,
  voiceConfig,
  sockets: satelliteSockets,
  log: jsonLog,
  onStreamStarted: ({ satelliteId, activationId }) => {
    if (voiceInputSessions.session(satelliteId)) {
      voiceStates.speaking(satelliteId, { activationId, reason: "tts_started" });
    }
  },
  onStreamFailed: ({ satelliteId, reason }) => {
    const session = voiceInputSessions.session(satelliteId);
    if (!session || (reason === "spoken_interruption" && session.state === "listening")) return;
    voiceStates.complete(satelliteId, "tts_failed");
  }
});
const continuousVoiceRecognition = new ContinuousVoiceRecognitionService({
  speechToText,
  voiceStates,
  sessionProvider: (satelliteId) => voiceInputSessions.session(satelliteId),
  initialNoiseFloorDb: Number(env("VOICE_INITIAL_NOISE_FLOOR_DB", "-50")),
  speechStartMarginDb: Number(env("VOICE_SPEECH_START_MARGIN_DB", "8")),
  speechEndMarginDb: Number(env("VOICE_SPEECH_END_MARGIN_DB", "5")),
  minimumSpeechMs: Number(env("VOICE_MINIMUM_SPEECH_MS", "120")),
  silenceDurationMs: Number(env("VOICE_SILENCE_DURATION_MS", "800")),
  preRollMs: Number(env("VOICE_PRE_ROLL_MS", "400")),
  maximumPhraseMs: Number(env("VOICE_MAXIMUM_PHRASE_MS", "8000")),
  partialIntervalMs: Number(env("VOICE_CONTINUOUS_PARTIAL_INTERVAL_MS", "700")),
  partialMinimumMs: Number(env("VOICE_CONTINUOUS_PARTIAL_MINIMUM_MS", "700")),
  listeningTimeoutMs: voiceListeningTimeoutMs,
  onPartial: ({ satelliteId, activationId, text, command, final, interruption }) => {
    broadcast(createEvent(EventType.TRANSCRIPT_PARTIAL, {
      targetSatelliteId: satelliteId,
      activationId,
      text,
      command: command || "",
      final: final === true,
      interruption: interruption === true
    }, satelliteId));
  },
  onCommand: ({ satelliteId, activationId, transcript }) => processVoiceTranscript(transcript, satelliteId, {
    activationId,
    origin: "continuous"
  }),
  onInterrupt: ({ satelliteId, activationId, text }) => {
    const session = voiceInputSessions.session(satelliteId);
    if (!session || session.activationId !== activationId) return;
    ttsStreams.cancel(satelliteId, "spoken_interruption");
    voiceStates.interruptAndListen(satelliteId, {
      timeoutMs: voiceListeningTimeoutMs,
      reason: "spoken_interruption"
    });
    jsonLog("info", "Interrupción de voz reconocida", { satelliteId, activationId, text });
  },
  log: jsonLog
});

const server = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  response.setHeader("Content-Type", "application/json");
  if (request.method === "OPTIONS") return response.end();
  if (request.url === "/health") return response.end(JSON.stringify({
    status: "ok",
    server: serverIdentity,
    protocolVersion: PROTOCOL_VERSION,
    activeVoiceInputStreams: voiceInputSessions.activeCount()
  }));
  if (request.url === "/identity") return response.end(JSON.stringify({ server: serverIdentity, protocolVersion: PROTOCOL_VERSION, port }));
  if (request.url === "/version" && request.method === "GET") return response.end(JSON.stringify({ component: "server", version: serverVersion, server: serverIdentity }));
  if (request.url === "/voice/input/sessions" && request.method === "GET") {
    return response.end(JSON.stringify({ sessions: voiceInputSessions.list() }));
  }
  if (request.url === "/voice/states" && request.method === "GET") {
    return response.end(JSON.stringify({ sessions: voiceStates.list() }));
  }
  if (request.url === "/voice/pipeline" && request.method === "GET") {
    return response.end(JSON.stringify({ enabled: true, provider: "stt", sessions: continuousVoiceRecognition.list() }));
  }
  if (request.url === "/config/location" && request.method === "GET") return response.end(JSON.stringify({ location: serverConfig.location }));
  if (request.url === "/config/location" && request.method === "PUT") return handleLocationUpdate(request, response);
  if (request.url === "/config/location/detect" && request.method === "POST") return handleLocationDetection(response);
  if (request.url === "/config/llm" && request.method === "GET") return handleLlmGet(response);
  if (request.url === "/config/llm" && request.method === "PUT") return handleLlmUpdate(request, response);
  if (request.url === "/config/llm/test" && request.method === "POST") return handleLlmTest(request, response);
  if (request.url === "/config/llm/credential" && request.method === "DELETE") return handleLlmCredentialDelete(response);
  if (request.url === "/home/devices" && request.method === "GET") return requireHomeAssistant(response, () => response.end(JSON.stringify(homeAssistantCatalog.snapshot())));
  if (request.url === "/home/devices/refresh" && request.method === "POST") return requireHomeAssistant(response, async () => response.end(JSON.stringify(await homeAssistantCatalog.refresh())));
  if (request.url === "/home/integrations/home-assistant" && request.method === "GET") return handleHomeAssistantGet(response);
  if (request.url === "/home/integrations/home-assistant" && request.method === "PUT") return handleHomeAssistantUpdate(request, response);
  if (request.url === "/home/integrations/home-assistant/test" && request.method === "POST") return handleHomeAssistantTest(request, response);
  if (request.url === "/home/integrations/home-assistant/credential" && request.method === "DELETE") return handleHomeAssistantCredentialDelete(response);
  if (request.url?.startsWith("/tts/")) return handleTtsRequest(request, response);
  void proxyMusicGateway(request, response).then((proxied) => {
    if (proxied) return true;
    return serveDisplay(request, response);
  }).then((served) => {
    if (served) return;
    response.statusCode = 404;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ error: "not_found" }));
  }).catch((error) => {
    jsonLog("error", "No se pudo servir la aplicación web", { error: error.message });
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ error: "display_unavailable" }));
  });
});

async function handleTtsRequest(request, response) {
  try {
    const url = new URL(request.url, "http://localhost");
    const match = /^\/tts\/satellites\/([^/]+)$/.exec(url.pathname);
    const preview = /^\/tts\/satellites\/([^/]+)\/preview$/.exec(url.pathname);
    if (request.method === "GET" && url.pathname === "/tts/voices") {
      const satelliteId = url.searchParams.get("satelliteId") || "";
      return response.end(JSON.stringify(await ttsStreams.catalog(satelliteId)));
    }
    if (request.method === "GET" && match) {
      return response.end(JSON.stringify(await ttsStreams.catalog(decodeURIComponent(match[1]))));
    }
    if (request.method === "PUT" && match) {
      const body = await readJsonRequest(request);
      return response.end(JSON.stringify(await ttsStreams.assign(decodeURIComponent(match[1]), body.voiceId)));
    }
    if (request.method === "POST" && preview) {
      const satelliteId = decodeURIComponent(preview[1]);
      const body = await readJsonRequest(request);
      if (!ttsStreams.isConnected(satelliteId)) {
        response.statusCode = 409;
        return response.end(JSON.stringify({ error: "satellite_not_connected", message: "El satélite no está conectado al servidor" }));
      }
      void ttsStreams.speak(String(body.text || "Hola, esta es una prueba de mi voz."), satelliteId)
        .catch((error) => jsonLog("warn", "Falló la prueba de voz", { satelliteId, error: error.message }));
      response.statusCode = 202;
      return response.end(JSON.stringify({ accepted: true, satelliteId }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: "invalid_tts_request", message: error.message }));
  }
}

async function readJsonRequest(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Solicitud demasiado grande");
  }
  return JSON.parse(body);
}

function requireHomeAssistant(response, operation) {
  if (serverConfig.homeAutomation.homeAssistant.enabled) return operation();
  response.statusCode = 409;
  response.end(JSON.stringify({ error: "home_assistant_disabled", message: "Home Assistant no está instalado en este servidor" }));
}

function publicHomeAssistantConfig() {
  return { ...serverConfig.homeAutomation.homeAssistant, credential: { configured: Boolean(serverSecrets.homeAssistant?.token) } };
}

function homeAssistantCandidate(body) {
  if (!serverConfig.homeAutomation.homeAssistant.enabled) throw new Error("Home Assistant no está habilitado en este servidor");
  const config = validateHomeAssistantConfig({ ...body, enabled: true });
  const token = String(body.token || serverSecrets.homeAssistant?.token || "").trim();
  if (!token) throw new Error("El token de larga duración es obligatorio");
  return { config, secret: { token }, client: new HomeAssistantClient({ ...config, token }) };
}

async function handleHomeAssistantGet(response) { response.end(JSON.stringify({ config: publicHomeAssistantConfig() })); }

async function handleHomeAssistantTest(request, response) {
  try { const candidate = homeAssistantCandidate(await readJsonRequest(request)); await candidate.client.test(); response.end(JSON.stringify({ ok: true })); }
  catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: "home_assistant_test_failed", message: error.message })); }
}

async function handleHomeAssistantUpdate(request, response) {
  try {
    const candidate = homeAssistantCandidate(await readJsonRequest(request));
    await candidate.client.test();
    const nextConfig = { ...serverConfig, homeAutomation: { ...serverConfig.homeAutomation, homeAssistant: candidate.config } };
    const nextSecrets = { ...serverSecrets, homeAssistant: candidate.secret };
    await writeServerSecrets(serverSecretsPath, nextSecrets);
    await writeServerConfig(serverConfigPath, nextConfig);
    serverConfig.homeAutomation = nextConfig.homeAutomation;
    serverSecrets.homeAssistant = candidate.secret;
    homeAssistantGateway.setClient(candidate.client);
    await homeAssistantCatalog.refresh();
    response.end(JSON.stringify({ config: publicHomeAssistantConfig() }));
  } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: "invalid_home_assistant_configuration", message: error.message })); }
}

async function handleHomeAssistantCredentialDelete(response) {
  try {
    const next = { ...serverSecrets }; delete next.homeAssistant;
    await writeServerSecrets(serverSecretsPath, next);
    serverSecrets.homeAssistant = {};
    homeAssistantGateway.setClient(null);
    await homeAssistantCatalog.refresh();
    response.end(JSON.stringify({ config: publicHomeAssistantConfig() }));
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: "credential_delete_failed", message: error.message })); }
}

async function handleLocationUpdate(request, response) {
  try {
    serverConfig.location = validateLocation({ ...(await readJsonRequest(request)), source: "manual" });
    await writeServerConfig(serverConfigPath, serverConfig);
    jsonLog("info", "Ubicación del servidor actualizada", serverConfig.location);
    void publishWeatherUpdate();
    response.end(JSON.stringify({ location: serverConfig.location }));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: "invalid_location", message: error.message }));
  }
}

async function handleLocationDetection(response) {
  try {
    response.end(JSON.stringify({ location: await ipLocationProvider.detect(), approximate: true }));
  } catch (error) {
    response.statusCode = 503;
    response.end(JSON.stringify({ error: "location_detection_unavailable", message: error.message }));
  }
}

function publicLlmConfig() {
  return {
    ...serverConfig.llm,
    credential: { configured: Boolean(serverSecrets.llm[serverConfig.llm.provider]?.apiKey) }
  };
}

function llmCandidate(body) {
  const config = validateLlmConfig(body);
  const previousSecret = serverSecrets.llm[config.provider] || {};
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : previousSecret.apiKey;
  if (["openai", "github-models"].includes(config.provider) && !apiKey) throw new Error("La API key es obligatoria para este proveedor");
  return { config, secret: apiKey ? { apiKey } : {} };
}

async function handleLlmGet(response) {
  response.end(JSON.stringify({ config: publicLlmConfig() }));
}

async function handleLlmTest(request, response) {
  try {
    const candidate = llmCandidate(await readJsonRequest(request));
    await testLlmClient(createLlmClient(candidate.config, candidate.secret));
    response.end(JSON.stringify({ ok: true }));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: "llm_test_failed", message: error.message }));
  }
}

async function handleLlmUpdate(request, response) {
  try {
    const candidate = llmCandidate(await readJsonRequest(request));
    const client = createLlmClient(candidate.config, candidate.secret);
    await testLlmClient(client);
    const nextConfig = { ...serverConfig, llm: candidate.config };
    const nextSecrets = { ...serverSecrets, llm: { ...serverSecrets.llm, [candidate.config.provider]: candidate.secret } };
    await writeServerSecrets(serverSecretsPath, nextSecrets);
    await writeServerConfig(serverConfigPath, nextConfig);
    serverConfig.llm = candidate.config;
    serverSecrets.llm = nextSecrets.llm;
    llmClientManager.activate(client);
    jsonLog("info", "Proveedor LLM actualizado", { provider: candidate.config.provider, baseUrl: candidate.config.baseUrl, model: candidate.config.model });
    response.end(JSON.stringify({ config: publicLlmConfig() }));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: "invalid_llm_configuration", message: error.message }));
  }
}

async function handleLlmCredentialDelete(response) {
  try {
    const provider = serverConfig.llm.provider;
    const nextLlmSecrets = { ...serverSecrets.llm };
    delete nextLlmSecrets[provider];
    await writeServerSecrets(serverSecretsPath, { ...serverSecrets, llm: nextLlmSecrets });
    serverSecrets.llm = nextLlmSecrets;
    llmClientManager.activate(createLlmClient(serverConfig.llm, {}));
    response.end(JSON.stringify({ config: publicLlmConfig() }));
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ error: "credential_delete_failed", message: error.message }));
  }
}

const websocket = new WebSocketServer({ server, path: "/ws" });

function broadcast(event, sender) {
  const encoded = JSON.stringify(event);
  for (const client of websocket.clients) {
    if (client !== sender && client.readyState === WebSocket.OPEN) client.send(encoded);
  }
}

function publishAssistantResponse(text, targetSatelliteId, {
  speak = true,
  commandProcessed,
  activationId = null
} = {}) {
  const expectsReply = responseExpectsReply(text);
  const responseEvent = createEvent(EventType.ASSISTANT_RESPONSE, {
    text,
    expectsReply,
    targetSatelliteId,
    speechRequested: speak,
    ...(typeof commandProcessed === "boolean" ? { commandProcessed } : {}),
    ...(activationId ? { activationId } : {})
  }, "server");
  broadcast(responseEvent);
  if (!speak) {
    voiceStates.complete(targetSatelliteId, "response_without_speech");
    return;
  }
  void ttsStreams.speak(text, targetSatelliteId, {
    responseId: responseEvent.id,
    expectsReply,
    followUpTimeoutMs: expectsReply ? followUpTimeoutMs : 0,
    activationId
  }).catch((error) => jsonLog("warn", "No se pudo transmitir la respuesta TTS", { targetSatelliteId, error: error.message }));
}

async function publishWeatherUpdate() {
  try {
    const weather = await weatherProvider.get(serverConfig.location);
    broadcast(createEvent(EventType.WEATHER_UPDATED, {
      ...weather.current,
      location: weather.location,
      fetchedAt: weather.fetchedAt,
      provider: weather.provider
    }, "server"));
  } catch (error) {
    jsonLog("warn", "No se pudo actualizar el clima", { error: error.message });
  }
}

async function respondToCommand(text, source, context = {}) {
  const activationId = context.activationId || voiceInputSessions.session(source)?.activationId || null;
  voiceStates.processing(source, { reason: "assistant_processing", activationId });
  broadcast(createEvent(EventType.ASSISTANT_PROCESSING, {
    text: "Procesando tu solicitud…",
    targetSatelliteId: source
  }, "server"));
  if (isConversationResetCommand(text)) {
    conversationMemory.clear(source);
    const answer = "Listo, olvidé nuestra conversación. Empecemos de nuevo.";
    publishAssistantResponse(answer, source, {
      commandProcessed: true,
      activationId
    });
    jsonLog("info", "Memoria de conversación reiniciada", { source });
    return;
  }
  try {
    let suppressSpeech = false;
    const history = conversationMemory.getHistory(source);
    jsonLog("info", "Interpretando comando", { text, source, historyMessages: history.length });
    const generatedAnswer = await assistantAgent.respond(text, {
      ...baseAssistantContext,
      assistantName: context.assistantName || defaultAssistantName,
      connectedPowerDeviceId: context.connectedPowerDeviceId || null,
      location: serverConfig.location,
      satelliteId: source,
      history,
      suppressSpeech: () => { suppressSpeech = true; }
    });
    const currentVoiceSession = voiceInputSessions.session(source);
    if (activationId && currentVoiceSession?.activationId !== activationId) {
      jsonLog("info", "Respuesta obsoleta descartada después de una interrupción", {
        source,
        activationId,
        currentActivationId: currentVoiceSession?.activationId || null
      });
      return;
    }
    const answer = removeGenericFollowUp(generatedAnswer) || "Listo.";
    conversationMemory.appendTurn(source, text, answer);
    publishAssistantResponse(answer, source, {
      speak: !suppressSpeech,
      commandProcessed: true,
      activationId
    });
    jsonLog("info", "Respuesta del asistente creada", { text: answer, source, speechSuppressed: suppressSpeech });
  } catch (error) {
    jsonLog("warn", "No se pudo interpretar el comando", { error: error.message, source });
    const text = "Lo siento, no pude procesar esa solicitud.";
    publishAssistantResponse(text, source, {
      commandProcessed: false,
      activationId
    });
  }
}

async function processVoiceTranscript(transcript, source, {
  assistantName = null,
  connectedPowerDeviceId = null,
  activationId = null,
  origin = "local"
} = {}) {
  const currentSession = voiceInputSessions.session(source);
  if (["central", "continuous"].includes(origin) && (!currentSession || currentSession.activationId !== activationId)) {
    jsonLog("info", "Transcripción central obsoleta descartada", { source, activationId });
    return {
      accepted: false,
      transcript: String(transcript || "").trim(),
      text: String(transcript || "").trim(),
      assistantName: defaultAssistantName,
      awaitingCommand: false,
      ignoredAsNoise: true,
      reason: "stale_activation"
    };
  }
  const configured = satelliteVoiceConfigs.get(source) || {};
  const effectiveAssistantName = String(assistantName || configured.assistantName || configured.wakeWord || defaultAssistantName).trim();
  const effectivePowerDeviceId = String(connectedPowerDeviceId || configured.connectedPowerDeviceId || "").trim() || null;
  const authoritativeActivationId = currentSession?.activationId || activationId || null;
  const text = String(transcript || "").trim();
  const assistantNameOnly = isAssistantNameOnly(text, effectiveAssistantName);
  const meaningfulCommand = !assistantNameOnly && isMeaningfulVoiceCommand(text);
  const awaitingCommand = !meaningfulCommand;

  if (meaningfulCommand) {
    if (authoritativeActivationId) centralCommandAttempts.delete(authoritativeActivationId);
    voiceStates.processing(source, { reason: `${origin}_transcript_accepted`, activationId: authoritativeActivationId });
    broadcast(createEvent(EventType.TRANSCRIPT_RECEIVED, {
      text,
      transcript: text,
      assistantName: effectiveAssistantName,
      connectedPowerDeviceId: effectivePowerDeviceId,
      activationId: authoritativeActivationId,
      origin
    }, source));
    void respondToCommand(text, source, {
      assistantName: effectiveAssistantName,
      connectedPowerDeviceId: effectivePowerDeviceId,
      activationId: authoritativeActivationId
    });
  } else if (origin === "central" && authoritativeActivationId) {
    const attempts = centralCommandAttempts.get(authoritativeActivationId) || 0;
    if (attempts < 1) {
      centralCommandAttempts.set(authoritativeActivationId, attempts + 1);
      voiceStates.followUp(source, {
        timeoutMs: voiceListeningTimeoutMs,
        reason: assistantNameOnly ? "wake_word_only" : "central_noise_retry",
        requestListening: false
      });
    } else {
      centralCommandAttempts.delete(authoritativeActivationId);
      voiceStates.complete(source, assistantNameOnly ? "wake_word_without_command" : "central_noise");
    }
  }

  if (assistantNameOnly) {
    jsonLog("info", "Nombre aislado del asistente; esperando el comando siguiente", {
      transcript: text, assistantName: effectiveAssistantName, source, origin
    });
  } else if (!meaningfulCommand) {
    jsonLog("info", "Transcripción de ruido ignorada", { transcript: text, source, origin });
  }

  return {
    accepted: meaningfulCommand,
    transcript: text,
    text,
    assistantName: effectiveAssistantName,
    awaitingCommand,
    ignoredAsNoise: !meaningfulCommand && !assistantNameOnly,
    reason: assistantNameOnly ? "assistant_name_only" : meaningfulCommand ? "command" : "noise"
  };
}

websocket.on("connection", (socket, request) => {
  jsonLog("info", "Cliente WebSocket conectado", { remoteAddress: request.socket.remoteAddress });
  socket.send(JSON.stringify(createEvent(EventType.ASSISTANT_RESPONSE, {
    text: "Conexión establecida con el asistente."
  }, "server")));
  void publishWeatherUpdate();

  socket.on("message", (data, isBinary) => {
    try {
      if (isBinary) {
        const result = voiceInputSessions.accept(socket, data);
        const session = voiceInputSessions.session(socket.satelliteId);
        continuousVoiceRecognition.accept(socket.satelliteId, session, result);
        return;
      }
      const event = JSON.parse(data.toString());
      if (!isEvent(event)) throw new Error("Evento inválido");
      if (event.type === EventType.VOICE_STATE_CHANGED) throw new Error("voice.state.changed es autoritativo del servidor");
      jsonLog("info", "Evento recibido", { type: event.type, source: event.source });
      if (event.type === EventType.SATELLITE_CONNECTED) satelliteSockets.register(event.source, socket);
      if ([
        EventType.VOICE_LISTEN_REQUESTED,
        EventType.ASSISTANT_SPEECH_PLAYBACK_ENDED,
        EventType.TRANSCRIPT_RECEIVED
      ].includes(event.type) && (!socket.satelliteId || event.source !== socket.satelliteId)) {
        throw new Error("El evento de voz no pertenece al satélite registrado");
      }
      if (event.type === EventType.WAKE_WORD_CONFIGURED) {
        if (!socket.satelliteId || event.source !== socket.satelliteId) {
          throw new Error("La configuración wake word no pertenece al satélite registrado");
        }
        satelliteVoiceConfigs.set(event.source, {
          assistantName: String(event.payload?.wakeWord || defaultAssistantName).trim(),
          wakeWord: String(event.payload?.wakeWord || defaultAssistantName).trim(),
          connectedPowerDeviceId: String(event.payload?.connectedPowerDeviceId || "").trim() || null
        });
        continuousVoiceRecognition.configure(event.source, event.payload);
        return;
      }
      if (event.type === EventType.VOICE_INPUT_STREAM_STARTED) {
        voiceInputSessions.start(socket, event);
        voiceStates.register(event.source);
        return;
      }
      if (event.type === EventType.VOICE_INPUT_STREAM_ENDED) {
        voiceStates.remove(event.source);
        continuousVoiceRecognition.remove(event.source);
        voiceInputSessions.end(socket, event);
        return;
      }
      if (event.type === EventType.VOICE_LISTEN_REQUESTED) {
        if (!socket.satelliteId || event.source !== socket.satelliteId) {
          throw new Error("La solicitud de escucha no pertenece al satélite registrado");
        }
        voiceStates.activate(event.source, {
          reason: event.payload?.reason || "manual_request",
          timeoutMs: Number(event.payload?.timeoutMs) || voiceListeningTimeoutMs,
          requestListening: false,
          metadata: { manual: event.payload?.manual === true }
        });
        return;
      }
      if (event.type === EventType.ASSISTANT_SPEECH_PLAYBACK_ENDED) {
        if (!socket.satelliteId || event.source !== socket.satelliteId) {
          throw new Error("El cierre de reproducción no pertenece al satélite registrado");
        }
        const session = voiceInputSessions.session(event.source);
        if (event.payload?.activationId && session?.activationId !== event.payload.activationId) return;
        if (event.payload?.expectsReply === true && event.payload?.failed !== true) {
          voiceStates.followUp(event.source, {
            timeoutMs: Number(event.payload?.followUpTimeoutMs) || followUpTimeoutMs,
            reason: "tts_playback_completed"
          });
        } else {
          voiceStates.complete(event.source, event.payload?.failed ? "tts_playback_failed" : "tts_playback_completed");
        }
      }
      broadcast(event, socket);

      if (event.type === EventType.TRANSCRIPT_RECEIVED) {
        const connectedPowerDeviceId = String(event.payload.connectedPowerDeviceId || "").trim();
        if (connectedPowerDeviceId && !/^switch\.[a-z0-9_]+$/.test(connectedPowerDeviceId)) {
          throw new Error("El evento contiene un enchufe conectado inválido");
        }
        void respondToCommand(event.payload.text, event.source, {
          assistantName: event.payload.assistantName || defaultAssistantName,
          connectedPowerDeviceId: connectedPowerDeviceId || null,
          activationId: voiceInputSessions.session(event.source)?.activationId || null
        });
      }
    } catch (error) {
      jsonLog("warn", "Mensaje WebSocket rechazado", { error: error.message });
    }
  });
  socket.on("close", () => {
    if (socket.satelliteId) {
      voiceStates.remove(socket.satelliteId);
      continuousVoiceRecognition.remove(socket.satelliteId);
      satelliteVoiceConfigs.delete(socket.satelliteId);
    }
    voiceInputSessions.remove(socket);
    satelliteSockets.remove(socket);
  });
});

const weatherRefresh = setInterval(() => void publishWeatherUpdate(), 15 * 60_000);
weatherRefresh.unref();
const homeAssistantRefresh = setInterval(() => void homeAssistantCatalog.refresh(), Number(env("HOME_ASSISTANT_REFRESH_MS", "60000")));
homeAssistantRefresh.unref();
const voiceInputMetrics = setInterval(
  () => {
    voiceInputSessions.logMetrics();
  },
  Math.max(1_000, Number(env("VOICE_INPUT_METRICS_INTERVAL_MS", "10000")) || 10_000)
);
voiceInputMetrics.unref();
server.listen(port, "0.0.0.0", () => {
  jsonLog("info", "Servidor iniciado", { port, server: serverIdentity, ...serverConfig });
  void publishWeatherUpdate();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    clearInterval(voiceInputMetrics);
    voiceStates.close();
    speechToText.close();
    streamingTtsProvider.close?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
