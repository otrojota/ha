import {
  createEvent,
  decodeAudioFrame,
  encodeVoiceInputFrame,
  PROTOCOL_VERSION,
  VOICE_INPUT_CHANNELS,
  VOICE_INPUT_FRAME_DURATION_MS,
  VOICE_INPUT_SAMPLE_RATE
} from "./browser-audio-protocol.js";

const MAX_BUFFERED_BYTES = 256 * 1024;
const RECONNECT_DELAY_MS = 3_000;
const HEARTBEAT_MS = 15_000;

let configuration = null;
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let generation = 0;
let capturePort = null;
let playbackPort = null;
let streamId = null;
let sequence = 0;
let sentFrames = 0;
let droppedFrames = 0;
let activePlayback = null;

function publish(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function sendEvent(type, payload = {}) {
  if (!configuration || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(createEvent(type, payload, configuration.satelliteId)));
  return true;
}

function startVoiceStream() {
  streamId = crypto.randomUUID();
  sequence = 0;
  sentFrames = 0;
  droppedFrames = 0;
  sendEvent("voice.input.stream.started", {
    streamId,
    format: "pcm_s16le",
    sampleRate: VOICE_INPUT_SAMPLE_RATE,
    channels: VOICE_INPUT_CHANNELS,
    frameDurationMs: VOICE_INPUT_FRAME_DURATION_MS
  });
}

function endVoiceStream(reason = "stopped") {
  if (!streamId) return;
  sendEvent("voice.input.stream.ended", { streamId, reason, sentFrames, droppedFrames });
  streamId = null;
}

function handleCaptureMessage(message) {
  if (message?.type === "capture.level") {
    publish("audio.level", { level: message });
    return;
  }
  if (message?.type !== "capture.frame" || !(message.audio instanceof ArrayBuffer)) return;
  if (!streamId || socket?.readyState !== WebSocket.OPEN) return;
  const currentSequence = sequence;
  sequence = (sequence + 1) >>> 0;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    droppedFrames += 1;
    if (droppedFrames === 1 || droppedFrames % 250 === 0) {
      publish("diagnostic", { level: "warn", message: "Audio descartado por backpressure", droppedFrames });
    }
    return;
  }
  try {
    socket.send(encodeVoiceInputFrame(streamId, currentSequence, Math.max(0, Math.round(message.capturedAtMs)), message.audio));
    sentFrames += 1;
  } catch (error) {
    publish("error", { message: error.message });
  }
}

function finishPlayback(message) {
  if (!activePlayback || message.streamId !== activePlayback.streamId) return;
  const playback = activePlayback;
  activePlayback = null;
  sendEvent("assistant.speech.playback.ended", {
    streamId: playback.streamId,
    activationId: playback.activationId,
    expectsReply: playback.expectsReply,
    followUpTimeoutMs: playback.followUpTimeoutMs,
    failed: message.failed === true,
    ...(message.reason ? { reason: message.reason } : {})
  });
  publish("playback.state", { state: "idle", streamId: playback.streamId, failed: message.failed === true });
}

function attachCapturePort(port) {
  capturePort?.close?.();
  capturePort = port;
  capturePort.onmessage = ({ data }) => handleCaptureMessage(data);
  capturePort.start?.();
}

function attachPlaybackPort(port) {
  playbackPort?.close?.();
  playbackPort = port;
  playbackPort.onmessage = ({ data }) => {
    if (data?.type === "playback.ended") finishPlayback(data);
  };
  playbackPort.start?.();
}

function handleServerEvent(event) {
  if (!event || event.protocolVersion !== PROTOCOL_VERSION) {
    publish("incompatible", { protocolVersion: event?.protocolVersion || null });
    socket?.close(4002, "Protocolo incompatible");
    return;
  }
  publish("server.event", { event });
  const payload = event.payload || {};
  if (payload.targetSatelliteId && payload.targetSatelliteId !== configuration?.satelliteId) return;
  if (event.type === "assistant.speech.stream.started") {
    if (activePlayback) playbackPort?.postMessage({ type: "playback.abort", reason: "replaced" });
    activePlayback = {
      streamId: payload.streamId,
      activationId: payload.activationId || null,
      expectsReply: payload.expectsReply === true,
      followUpTimeoutMs: Number(payload.followUpTimeoutMs) || 0,
      nextSequence: 0
    };
    playbackPort?.postMessage({
      type: "playback.start",
      streamId: payload.streamId,
      sampleRate: Number(payload.sampleRate),
      channels: Number(payload.channels || 1)
    });
    publish("playback.state", { state: "playing", streamId: payload.streamId });
  }
  if (["assistant.speech.stream.ended", "assistant.speech.stream.failed"].includes(event.type)
    && activePlayback?.streamId === payload.streamId) {
    playbackPort?.postMessage({ type: "playback.end", failed: event.type.endsWith("failed") });
  }
}

async function handleSocketMessage(message) {
  try {
    if (typeof message.data === "string") {
      handleServerEvent(JSON.parse(message.data));
      return;
    }
    const data = message.data instanceof Blob ? await message.data.arrayBuffer() : message.data;
    const frame = decodeAudioFrame(data);
    if (!activePlayback || frame.streamId !== activePlayback.streamId) return;
    if (frame.sequence !== activePlayback.nextSequence) {
      const reason = `Secuencia TTS inesperada: ${frame.sequence}; esperada: ${activePlayback.nextSequence}`;
      playbackPort?.postMessage({ type: "playback.abort", reason });
      publish("error", { message: reason });
      return;
    }
    activePlayback.nextSequence += 1;
    playbackPort?.postMessage({ type: "playback.chunk", audio: frame.audio }, [frame.audio]);
  } catch (error) {
    publish("error", { message: `Mensaje del servidor inválido: ${error.message}` });
  }
}

function clearConnectionTimers() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  reconnectTimer = null;
  heartbeatTimer = null;
}

function disconnect(reason = "reconfigured") {
  generation += 1;
  clearConnectionTimers();
  endVoiceStream(reason);
  const previous = socket;
  socket = null;
  previous?.close();
}

function connect(connectionGeneration = generation) {
  if (!configuration?.webSocketUrl || connectionGeneration !== generation) return;
  const candidate = new WebSocket(configuration.webSocketUrl);
  candidate.binaryType = "arraybuffer";
  socket = candidate;
  publish("connection.state", { state: "connecting" });
  candidate.addEventListener("open", () => {
    if (candidate !== socket || connectionGeneration !== generation) return candidate.close();
    sendEvent("satellite.connected", configuration.satellite);
    sendEvent("voice.wake-word.configured", configuration.wakeWord);
    startVoiceStream();
    heartbeatTimer = setInterval(() => sendEvent("satellite.heartbeat", configuration.satellite), HEARTBEAT_MS);
    publish("connection.state", { state: "connected" });
  });
  candidate.addEventListener("message", handleSocketMessage);
  candidate.addEventListener("error", () => candidate.close());
  candidate.addEventListener("close", () => {
    if (socket !== candidate) return;
    socket = null;
    streamId = null;
    clearConnectionTimers();
    if (activePlayback) {
      playbackPort?.postMessage({ type: "playback.abort", reason: "server_disconnected" });
      activePlayback = null;
    }
    publish("connection.state", { state: "disconnected" });
    reconnectTimer = setTimeout(() => connect(connectionGeneration), RECONNECT_DELAY_MS);
  });
}

self.onmessage = ({ data }) => {
  if (data?.type === "capture.port" && data.port) return attachCapturePort(data.port);
  if (data?.type === "playback.port" && data.port) return attachPlaybackPort(data.port);
  if (data?.type === "configure") {
    disconnect("reconfigured");
    configuration = data.configuration;
    generation += 1;
    connect(generation);
    return;
  }
  if (data?.type === "wake-word.configure") {
    configuration = { ...configuration, wakeWord: data.wakeWord };
    sendEvent("voice.wake-word.configured", data.wakeWord);
    return;
  }
  if (data?.type === "event.send") sendEvent(data.eventType, data.payload || {});
  if (data?.type === "disconnect") disconnect(data.reason || "stopped");
};

