import { createServer } from "node:http";
import { hostname } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { createEvent, EventType, isEvent } from "@ha/contracts";
import { env, jsonLog } from "@ha/shared";
import { WhisperCliSpeechToText } from "./speech/whisper-cli-speech-to-text.js";
import { commandAfterWakeWord } from "./speech/wake-word.js";
import { isMeaningfulVoiceCommand } from "./speech/voice-command.js";
import { AssistantAgent } from "./agent/assistant-agent.js";
import { OllamaClient } from "./agent/ollama-client.js";
import { ToolRegistry } from "./agent/tool-registry.js";
import { getIdentityTool } from "./tools/assistant/get-identity.tool.js";
import { getCurrentDateTimeTool } from "./tools/datetime/get-current-datetime.tool.js";
import { getDateInfoTool } from "./tools/datetime/get-date-info.tool.js";
import { getDateDifferenceTool } from "./tools/datetime/get-date-difference.tool.js";
import { readServerConfig, validateLocation, writeServerConfig } from "./config/server-config.js";
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
import { responseExpectsReply } from "./speech/assistant-response.js";
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
import { readOrCreateServerIdentity } from "./discovery/server-identity.js";
import { ServerAdvertiser } from "./discovery/server-advertiser.js";

const port = Number(env("SERVER_PORT", "3000"));
const serverConfigPath = "dev/server/config/server.json";
const serverHostName = hostname().replace(/\.local$/i, "");
const serverIdentity = await readOrCreateServerIdentity(
  env("SERVER_IDENTITY_PATH", `dev/server/config/identity-${serverHostName}.json`),
  { name: env("SERVER_NAME", `Servidor ${serverHostName}`), log: jsonLog }
);
const serverAdvertiser = new ServerAdvertiser({ identity: serverIdentity, port, log: jsonLog });
const defaultAssistantName = "Asistente";
const followUpTimeoutMs = 5000;
const serverConfig = await readServerConfig(serverConfigPath, jsonLog);
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
const alarmScheduler = new AlarmScheduler({
  storagePath: env("ALARM_CONFIG_PATH", "dev/server/config/alarms.json"),
  log: jsonLog,
  onFire: async (alarm) => publishAssistantResponse(alarmMessage(alarm.kind, alarm.label), alarm.satelliteId)
});
await alarmScheduler.start();
tools.push(createSetAlarmTool({ scheduler: alarmScheduler }));
tools.push(createListAlarmsTool({ scheduler: alarmScheduler }));
tools.push(createCancelAlarmTool({ scheduler: alarmScheduler }));
tools.push(createGetAlarmRemainingTool({ scheduler: alarmScheduler }));
const musicGateway = new MusicGatewayClient({
  baseUrl: env("MUSIC_GATEWAY_URL", "http://localhost:3100"),
  timeoutMs: Number(env("MUSIC_GATEWAY_TIMEOUT_MS", "90000"))
});
tools.push(createListMusicDestinationsTool({ music: musicGateway }));
tools.push(createListMusicSourcesTool({ music: musicGateway }));
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
const assistantAgent = new AssistantAgent({
  client: new OllamaClient({
    url: env("OLLAMA_URL", "http://localhost:11434"),
    model: env("OLLAMA_MODEL", "qwen3.5:9b"),
    think: env("OLLAMA_THINK", "false") === "true",
    keepAlive: env("OLLAMA_KEEP_ALIVE", "30m"),
    temperature: Number(env("OLLAMA_TEMPERATURE", "0.1")),
    contextLength: Number(env("OLLAMA_CONTEXT_LENGTH", "8192"))
  }),
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
  response.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  response.setHeader("Content-Type", "application/json");
  if (request.method === "OPTIONS") return response.end();
  if (request.url === "/health") return response.end(JSON.stringify({ status: "ok", server: serverIdentity, protocolVersion: "1" }));
  if (request.url === "/identity") return response.end(JSON.stringify({ server: serverIdentity, protocolVersion: "1", port }));
  if (request.url === "/config/location" && request.method === "GET") return response.end(JSON.stringify({ location: serverConfig.location }));
  if (request.url === "/config/location" && request.method === "PUT") return handleLocationUpdate(request, response);
  if (request.url === "/config/location/detect" && request.method === "POST") return handleLocationDetection(response);
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

const websocket = new WebSocketServer({ server, path: "/ws" });

function broadcast(event, sender) {
  const encoded = JSON.stringify(event);
  for (const client of websocket.clients) {
    if (client !== sender && client.readyState === WebSocket.OPEN) client.send(encoded);
  }
}

function publishAssistantResponse(text, targetSatelliteId) {
  const expectsReply = responseExpectsReply(text);
  const responseEvent = createEvent(EventType.ASSISTANT_RESPONSE, { text, expectsReply }, "server");
  broadcast(responseEvent);
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
    text: "Procesando tu solicitud…"
  }, "server"));
  if (isConversationResetCommand(text)) {
    conversationMemory.clear(source);
    const answer = "Listo, olvidé nuestra conversación. Empecemos de nuevo.";
    publishAssistantResponse(answer, source);
    jsonLog("info", "Memoria de conversación reiniciada", { source });
    return;
  }
  try {
    const history = conversationMemory.getHistory(source);
    jsonLog("info", "Interpretando comando", { text, source, historyMessages: history.length });
    const answer = await assistantAgent.respond(text, {
      ...baseAssistantContext,
      assistantName: context.assistantName || defaultAssistantName,
      location: serverConfig.location,
      satelliteId: source,
      history
    });
    conversationMemory.appendTurn(source, text, answer);
    publishAssistantResponse(answer, source);
    jsonLog("info", "Respuesta del asistente creada", { text: answer, source });
  } catch (error) {
    jsonLog("warn", "No se pudo interpretar el comando", { error: error.message, source });
    const text = "Lo siento, no pude procesar esa solicitud.";
    publishAssistantResponse(text, source);
  }
}

async function handleTranscription(request, response) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 10_000_000) throw new Error("El audio supera el máximo de 10 MB");
      chunks.push(chunk);
    }
    const transcript = await speechToText.transcribe(Buffer.concat(chunks));
    const requestWakeWord = String(request.headers["x-wake-word"] || defaultAssistantName).trim();
    const command = commandAfterWakeWord(transcript, requestWakeWord);
    const detectedByWakeWord = request.headers["x-wake-word-detected"] === "true";
    const activated = detectedByWakeWord || command !== null;
    const text = command ?? transcript;
    const awaitingCommand = detectedByWakeWord && command === "";
    const meaningfulCommand = isMeaningfulVoiceCommand(text);
    if (activated && !awaitingCommand && meaningfulCommand) {
      const source = request.headers["x-satellite-id"] || "satellite";
      broadcast(createEvent(EventType.TRANSCRIPT_RECEIVED, {
        text,
        transcript,
        wakeWord: requestWakeWord
      }, source));
      void respondToCommand(text, source, { assistantName: requestWakeWord });
    }
    if (activated && !awaitingCommand && !meaningfulCommand) {
      jsonLog("info", "Transcripción de ruido ignorada", { transcript, source: request.headers["x-satellite-id"] || "satellite" });
    }
    response.end(JSON.stringify({ activated, transcript, text, wakeWord: requestWakeWord, awaitingCommand, ignoredAsNoise: activated && !awaitingCommand && !meaningfulCommand }));
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
      if (event.type !== EventType.AUDIO_LEVEL_UPDATED) {
        jsonLog("info", "Evento recibido", { type: event.type, source: event.source });
      }
      broadcast(event, socket);

      if (event.type === EventType.TRANSCRIPT_RECEIVED) {
        void respondToCommand(event.payload.text, event.source, { assistantName: event.payload.wakeWord });
      }
    } catch (error) {
      jsonLog("warn", "Mensaje WebSocket rechazado", { error: error.message });
    }
  });
});

const weatherRefresh = setInterval(() => void publishWeatherUpdate(), 15 * 60_000);
weatherRefresh.unref();
let lastPlaybackSnapshot = "";
const playbackRefresh = setInterval(async () => {
  try {
    const playback = await musicGateway.getPlayback();
    const snapshot = JSON.stringify(playback);
    if (snapshot !== lastPlaybackSnapshot) {
      lastPlaybackSnapshot = snapshot;
      broadcast(createEvent(EventType.PLAYBACK_CHANGED, playback, "music-assistant"));
    }
  } catch (error) {
    if (lastPlaybackSnapshot !== "unavailable") jsonLog("warn", "Music Assistant no está disponible para actualizar el display", { error: error.message });
    lastPlaybackSnapshot = "unavailable";
  }
}, 3_000);
playbackRefresh.unref();
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
