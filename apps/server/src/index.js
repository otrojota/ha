import { createServer } from "node:http";
import { hostname } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { createEvent, EventType, isEvent, PROTOCOL_VERSION } from "@ha/contracts";
import { configPath, env, jsonLog, readReleaseVersion } from "@ha/shared";
import { WhisperCliSpeechToText } from "./speech/whisper-cli-speech-to-text.js";
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
import { readOrCreateServerIdentity } from "./discovery/server-identity.js";
import { ServerAdvertiser } from "./discovery/server-advertiser.js";
import { DeviceGatewayRegistry } from "./home-automation/device-gateway-registry.js";
import { HomeAutomationService } from "./home-automation/home-automation-service.js";
import { createHomeLightTools } from "./tools/home/light-tools.js";
import { createHomeAssistantDeviceTools } from "./tools/home/home-assistant-device-tools.js";
import { HomeAssistantClient } from "./home-automation/home-assistant-client.js";
import { HomeAssistantRgbBulbGateway } from "./home-automation/home-assistant-rgb-bulb-gateway.js";
import { HomeAssistantCatalog } from "./home-automation/home-assistant-catalog.js";
import { ScheduledAutomationExecutor } from "./automations/scheduled-automation-executor.js";
import { createScheduleAutomationTool } from "./tools/automation/schedule-automation.tool.js";

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
const serverAdvertiser = new ServerAdvertiser({ identity: serverIdentity, port, log: jsonLog });
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
const musicGateway = new MusicGatewayClient({
  baseUrl: env("MUSIC_GATEWAY_URL", "http://localhost:3100"),
  timeoutMs: Number(env("MUSIC_GATEWAY_TIMEOUT_MS", "90000"))
});
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
const speechToText = new WhisperCliSpeechToText({
  executable: env("WHISPER_CLI", "whisper-cli"),
  modelPath: env("WHISPER_MODEL_PATH", ""),
  language: env("WHISPER_LANGUAGE", "es"),
  noGpu: env("WHISPER_NO_GPU", "false") === "true"
});

const server = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  response.setHeader("Content-Type", "application/json");
  if (request.method === "OPTIONS") return response.end();
  if (request.url === "/health") return response.end(JSON.stringify({ status: "ok", server: serverIdentity, protocolVersion: PROTOCOL_VERSION }));
  if (request.url === "/identity") return response.end(JSON.stringify({ server: serverIdentity, protocolVersion: PROTOCOL_VERSION, port }));
  if (request.url === "/version" && request.method === "GET") return response.end(JSON.stringify({ component: "server", version: serverVersion, server: serverIdentity }));
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
  if (request.method === "POST" && request.url === "/stt/transcribe") {
    return handleTranscription(request, response);
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not_found" }));
});

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

function publishAssistantResponse(text, targetSatelliteId, { speak = true } = {}) {
  const expectsReply = responseExpectsReply(text);
  const responseEvent = createEvent(EventType.ASSISTANT_RESPONSE, { text, expectsReply, targetSatelliteId }, "server");
  broadcast(responseEvent);
  if (!speak) return;
  broadcast(createEvent(EventType.ASSISTANT_SPEECH_REQUESTED, {
    text,
    responseId: responseEvent.id,
    targetSatelliteId,
    expectsReply,
    followUpTimeoutMs: expectsReply ? followUpTimeoutMs : 0
  }, "server"));
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
  broadcast(createEvent(EventType.ASSISTANT_PROCESSING, {
    text: "Procesando tu solicitud…",
    targetSatelliteId: source
  }, "server"));
  if (isConversationResetCommand(text)) {
    conversationMemory.clear(source);
    const answer = "Listo, olvidé nuestra conversación. Empecemos de nuevo.";
    publishAssistantResponse(answer, source);
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
    const answer = removeGenericFollowUp(generatedAnswer) || "Listo.";
    conversationMemory.appendTurn(source, text, answer);
    publishAssistantResponse(answer, source, { speak: !suppressSpeech });
    jsonLog("info", "Respuesta del asistente creada", { text: answer, source, speechSuppressed: suppressSpeech });
  } catch (error) {
    jsonLog("warn", "No se pudo interpretar el comando", { error: error.message, source });
    const text = "Lo siento, no pude procesar esa solicitud.";
    publishAssistantResponse(text, source);
  }
}

async function handleTranscription(request, response) {
  try {
    const source = String(request.headers["x-satellite-id"] || "").trim();
    if (!source) {
      response.statusCode = 400;
      return response.end(JSON.stringify({ error: "satellite_id_required", message: "Falta el encabezado X-Satellite-Id" }));
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 10_000_000) throw new Error("El audio supera el máximo de 10 MB");
      chunks.push(chunk);
    }
    const transcript = await speechToText.transcribe(Buffer.concat(chunks));
    const assistantName = String(request.headers["x-assistant-name"] || defaultAssistantName).trim();
    const connectedPowerDeviceId = String(request.headers["x-connected-power-device-id"] || "").trim();
    if (connectedPowerDeviceId && !/^switch\.[a-z0-9_]+$/.test(connectedPowerDeviceId)) {
      throw new Error("El enchufe conectado del satélite no es una entidad switch válida");
    }
    const text = transcript.trim();
    const assistantNameOnly = isAssistantNameOnly(text, assistantName);
    const meaningfulCommand = !assistantNameOnly && isMeaningfulVoiceCommand(text);
    const awaitingCommand = !meaningfulCommand;
    if (meaningfulCommand) {
      broadcast(createEvent(EventType.TRANSCRIPT_RECEIVED, {
        text,
        transcript,
        assistantName,
        connectedPowerDeviceId: connectedPowerDeviceId || null
      }, source));
      void respondToCommand(text, source, { assistantName, connectedPowerDeviceId: connectedPowerDeviceId || null });
    }
    if (assistantNameOnly) {
      jsonLog("info", "Nombre aislado del asistente; esperando el comando siguiente", { transcript, assistantName, source });
    } else if (!meaningfulCommand) {
      jsonLog("info", "Transcripción de ruido ignorada", { transcript, source });
    }
    response.end(JSON.stringify({
      accepted: meaningfulCommand,
      transcript,
      text,
      assistantName,
      awaitingCommand,
      ignoredAsNoise: !meaningfulCommand && !assistantNameOnly,
      reason: assistantNameOnly ? "assistant_name_only" : meaningfulCommand ? "command" : "noise"
    }));
  } catch (error) {
    jsonLog("warn", "No se pudo transcribir el audio", { error: error.message });
    response.statusCode = 503;
    response.end(JSON.stringify({ error: "transcription_unavailable", message: error.message }));
  }
}

websocket.on("connection", (socket, request) => {
  jsonLog("info", "Cliente WebSocket conectado", { remoteAddress: request.socket.remoteAddress });
  socket.send(JSON.stringify(createEvent(EventType.ASSISTANT_RESPONSE, {
    text: "Conexión establecida con el asistente."
  }, "server")));
  void publishWeatherUpdate();

  socket.on("message", (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (!isEvent(event)) throw new Error("Evento inválido");
      if (event.type === EventType.AUDIO_LEVEL_UPDATED) throw new Error("audio.level.updated es un evento exclusivamente local del satélite");
      jsonLog("info", "Evento recibido", { type: event.type, source: event.source });
      broadcast(event, socket);

      if (event.type === EventType.TRANSCRIPT_RECEIVED) {
        const connectedPowerDeviceId = String(event.payload.connectedPowerDeviceId || "").trim();
        if (connectedPowerDeviceId && !/^switch\.[a-z0-9_]+$/.test(connectedPowerDeviceId)) {
          throw new Error("El evento contiene un enchufe conectado inválido");
        }
        void respondToCommand(event.payload.text, event.source, {
          assistantName: event.payload.assistantName || defaultAssistantName,
          connectedPowerDeviceId: connectedPowerDeviceId || null
        });
      }
    } catch (error) {
      jsonLog("warn", "Mensaje WebSocket rechazado", { error: error.message });
    }
  });
});

const weatherRefresh = setInterval(() => void publishWeatherUpdate(), 15 * 60_000);
weatherRefresh.unref();
const homeAssistantRefresh = setInterval(() => void homeAssistantCatalog.refresh(), Number(env("HOME_ASSISTANT_REFRESH_MS", "60000")));
homeAssistantRefresh.unref();
server.listen(port, "0.0.0.0", () => {
  jsonLog("info", "Servidor iniciado", { port, server: serverIdentity, ...serverConfig });
  serverAdvertiser.start();
  void publishWeatherUpdate();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    serverAdvertiser.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
