import { spawn } from "node:child_process";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const PCM_BYTES_PER_MILLISECOND = 32; // mono, 16 kHz, signed 16-bit

export function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function captureInput(deviceId) {
  if (!deviceId) return process.platform === "darwin" ? ["-f", "avfoundation", "-i", ":default"] : ["-f", "pulse", "-i", "default"];
  const avfoundation = /^avfoundation:(\d+)$/.exec(deviceId || "");
  if (avfoundation) return ["-f", "avfoundation", "-i", `:${avfoundation[1]}`];
  if (deviceId && !deviceId.startsWith("simulated-")) return ["-f", "pulse", "-i", deviceId];
  return null;
}

export class AdaptiveVoiceActivityDetector {
  constructor({
    initialNoiseFloorDb = -50,
    startMarginDb = 10,
    endMarginDb = 6,
    minimumSpeechMs = 180,
    silenceDurationMs = 800,
    historySize = 80,
    calibrationFrames = 8
  } = {}) {
    this.noiseFloorDb = initialNoiseFloorDb;
    this.startMarginDb = startMarginDb;
    this.endMarginDb = endMarginDb;
    this.minimumSpeechMs = minimumSpeechMs;
    this.silenceDurationMs = silenceDurationMs;
    this.historySize = historySize;
    this.calibrationFrames = calibrationFrames;
    this.levelHistory = [];
    this.calibrated = false;
    this.resetPhrase();
  }

  resetPhrase() {
    this.speechStarted = false;
    this.loudDurationMs = 0;
    this.quietDurationMs = 0;
  }

  addLevel(db) {
    this.levelHistory.push(db);
    if (this.levelHistory.length > this.historySize) this.levelHistory.shift();
    const sorted = [...this.levelHistory].sort((a, b) => a - b);
    const percentileIndex = Math.floor((sorted.length - 1) * 0.2);
    const observedFloor = sorted[percentileIndex];
    const smoothing = observedFloor < this.noiseFloorDb ? 0.2 : 0.04;
    this.noiseFloorDb += (observedFloor - this.noiseFloorDb) * smoothing;
    this.noiseFloorDb = Math.min(-20, Math.max(-60, this.noiseFloorDb));
    if (this.levelHistory.length >= this.calibrationFrames) this.calibrated = true;
  }

  process(db, durationMs) {
    this.addLevel(db);
    const startThresholdDb = Math.min(-18, this.noiseFloorDb + this.startMarginDb);
    const endThresholdDb = Math.min(-22, this.noiseFloorDb + this.endMarginDb);

    if (!this.calibrated) return { speechStarted: false, phraseEnded: false, startThresholdDb, endThresholdDb };

    if (!this.speechStarted) {
      this.loudDurationMs = db >= startThresholdDb ? this.loudDurationMs + durationMs : 0;
      if (this.loudDurationMs >= this.minimumSpeechMs) this.speechStarted = true;
    } else {
      this.quietDurationMs = db < endThresholdDb ? this.quietDurationMs + durationMs : 0;
    }

    return {
      speechStarted: this.speechStarted,
      phraseEnded: this.speechStarted && this.quietDurationMs >= this.silenceDurationMs,
      startThresholdDb,
      endThresholdDb
    };
  }
}

export class VoiceCapture {
  constructor({
    readConfig,
    onPhrase,
    onListeningTimeout = () => {},
    onCaptureError = () => {},
    onAudio = () => {},
    onLevel = () => {},
    log,
    silenceDuration = 0.8,
    maxPhraseSeconds = 15,
    noiseFloorDb = -50,
    speechStartMarginDb = 10,
    speechEndMarginDb = 6,
    commandSpeechStartMarginDb = 6,
    commandMinimumSpeechMs = 100,
    preRollMs = 400,
    onCommandWindowStarted = () => {}
  }) {
    this.readConfig = readConfig;
    this.onPhrase = onPhrase;
    this.onListeningTimeout = onListeningTimeout;
    this.onCaptureError = onCaptureError;
    this.onAudio = onAudio;
    this.onLevel = onLevel;
    this.onCommandWindowStarted = onCommandWindowStarted;
    this.log = log;
    this.silenceDuration = silenceDuration;
    this.maxPhraseSeconds = maxPhraseSeconds;
    this.commandExpiresAt = 0;
    this.commandWindowMs = 0;
    this.bridgeCurrentPhrase = false;
    this.commandSpeechStartMarginDb = commandSpeechStartMarginDb;
    this.commandMinimumSpeechMs = commandMinimumSpeechMs;
    this.preRollBytes = Math.max(0, Math.round(preRollMs * PCM_BYTES_PER_MILLISECOND));
    this.activityDetector = new AdaptiveVoiceActivityDetector({
      initialNoiseFloorDb: noiseFloorDb,
      startMarginDb: speechStartMarginDb,
      endMarginDb: speechEndMarginDb,
      silenceDurationMs: silenceDuration * 1000
    });
    this.running = false;
    this.paused = false;
    this.process = null;
    this.generation = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    const generation = ++this.generation;
    this.loop(generation).catch((error) => this.log("warn", "Captura de voz detenida", { error: error.message }));
  }

  stop() {
    this.running = false;
    this.paused = true;
    this.generation += 1;
    this.process?.kill("SIGINT");
  }

  pause() {
    this.paused = true;
    this.process?.kill("SIGINT");
  }

  resume() {
    if (this.running) this.paused = false;
  }

  arm(commandWindowMs, { bridgeCurrentPhrase = false } = {}) {
    this.commandWindowMs = commandWindowMs;
    this.commandExpiresAt = Date.now() + commandWindowMs;
    this.bridgeCurrentPhrase = bridgeCurrentPhrase;
  }

  disarm() {
    this.commandWindowMs = 0;
    this.commandExpiresAt = 0;
    this.bridgeCurrentPhrase = false;
  }

  async loop(generation) {
    let consecutiveFailures = 0;
    while (this.running && this.generation === generation) {
      if (this.paused) {
        await delay(100);
        continue;
      }
      const config = await this.readConfig();
      const input = captureInput(config.inputDeviceId);
      if (!input || !Number.isInteger(config.inputChannel)) {
        await delay(1500);
        continue;
      }

      try {
        const capture = await this.capturePhrase(input, config.inputChannel);
        consecutiveFailures = 0;
        if (this.generation !== generation) continue;
        if (!this.paused && capture?.audio?.length > 44) {
          await this.onPhrase(capture.audio, {
            commandWasArmed: capture.commandWasArmed,
            bridgedCommand: capture.bridgedCommand === true
          });
        } else if (!this.paused && capture?.commandTimedOut) {
          await this.onListeningTimeout();
        }
      } catch (error) {
        if (this.paused || !this.running) continue;
        await this.onCaptureError(error);
        consecutiveFailures += 1;
        const retryDelayMs = Math.min(30_000, 1_500 * (2 ** (consecutiveFailures - 1)));
        this.log("warn", "No se pudo capturar audio", {
          error: error.message,
          consecutiveFailures,
          retryDelayMs
        });
        await delay(retryDelayMs);
      }
    }
  }

  async capturePhrase(input, channel) {
    const filter = `[0:a]pan=mono|c0=c${channel},aresample=16000[out]`;
    const args = [
      "-hide_banner", "-loglevel", "info", ...input,
      "-filter_complex", filter,
      "-map", "[out]", "-ac", "1", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"
    ];

    let speechStarted = false;
    let phraseEnded = false;
    let bridgedCommand = false;
    let commandSpeechStarted = false;
    let commandBoundaryByte = null;
    let speechStartByte = null;
    let commandSpeechStartByte = null;
    let activeDetector = this.activityDetector;
    const pcmChunks = [];
    let totalPcmBytes = 0;
    let stderr = "";
    this.activityDetector.resetPhrase();
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = child;
    const captureExpiresAt = Date.now() + this.maxPhraseSeconds * 1000;
    let stopRequested = false;
    let forceStopTimeout = null;
    let boundaryDecisionTimeout = null;
    const requestStop = () => {
      if (stopRequested || child.exitCode !== null || child.signalCode !== null) return;
      stopRequested = true;
      child.kill("SIGINT");
      forceStopTimeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000);
    };
    const timeout = setInterval(() => {
      const effectiveExpiresAt = this.commandExpiresAt || captureExpiresAt;
      if (Date.now() >= effectiveExpiresAt) requestStop();
    }, 100);

    let pendingByte = null;
    let sumSquares = 0;
    let sampleCount = 0;
    let peak = 0;
    child.stdout.on("data", (chunk) => {
      let data = chunk;
      if (pendingByte !== null) {
        data = Buffer.concat([Buffer.from([pendingByte]), chunk]);
        pendingByte = null;
      }
      if (data.length % 2) {
        pendingByte = data.at(-1);
        data = data.subarray(0, -1);
      }
      if (data.length) this.onAudio(data);
      if (data.length) {
        pcmChunks.push(data);
        totalPcmBytes += data.length;
      }
      for (let offset = 0; offset < data.length; offset += 2) {
        const sample = data.readInt16LE(offset);
        const absolute = Math.abs(sample);
        sumSquares += sample * sample;
        sampleCount += 1;
        if (absolute > peak) peak = absolute;
      }
      if (sampleCount >= 1600) {
        const rms = Math.sqrt(sumSquares / sampleCount) / 32768;
        const db = rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
        const durationMs = sampleCount / 16;
        if (this.commandExpiresAt > 0 && this.bridgeCurrentPhrase && !bridgedCommand) {
          bridgedCommand = true;
          this.bridgeCurrentPhrase = false;
          commandBoundaryByte = totalPcmBytes;
          activeDetector = new AdaptiveVoiceActivityDetector({
            initialNoiseFloorDb: this.activityDetector.noiseFloorDb,
            startMarginDb: this.commandSpeechStartMarginDb,
            endMarginDb: this.activityDetector.endMarginDb,
            minimumSpeechMs: this.commandMinimumSpeechMs,
            silenceDurationMs: this.activityDetector.silenceDurationMs,
            calibrationFrames: 1
          });
          this.commandExpiresAt = Date.now() + this.commandWindowMs;
          this.onCommandWindowStarted(this.commandWindowMs);
          clearTimeout(boundaryDecisionTimeout);
          boundaryDecisionTimeout = null;
        }
        const activity = activeDetector.process(db, durationMs);
        speechStarted ||= activity.speechStarted;
        if (bridgedCommand) commandSpeechStarted ||= activity.speechStarted;
        if (activity.speechStarted) {
          const estimatedStart = Math.max(0, totalPcmBytes - Math.round(activeDetector.loudDurationMs * PCM_BYTES_PER_MILLISECOND));
          if (bridgedCommand && commandSpeechStartByte === null) commandSpeechStartByte = estimatedStart;
          else if (!bridgedCommand && speechStartByte === null) speechStartByte = estimatedStart;
        }
        this.onLevel({ db: Number(db.toFixed(1)), level: Math.min(1, Math.max(0, (db + 60) / 60)), clipping: peak >= 32760 });
        sumSquares = 0;
        sampleCount = 0;
        peak = 0;
        if (activity.phraseEnded) {
          // Damos una ventana mínima al proceso Vosk para devolver su detección
          // final antes de cerrar ffmpeg. La comunicación entre procesos puede
          // llegar unas decenas de milisegundos después del mismo bloque de audio.
          if (!boundaryDecisionTimeout) boundaryDecisionTimeout = setTimeout(() => {
            boundaryDecisionTimeout = null;
            if (this.commandExpiresAt > 0 && this.bridgeCurrentPhrase && !bridgedCommand) {
              bridgedCommand = true;
              this.bridgeCurrentPhrase = false;
              commandBoundaryByte = totalPcmBytes;
              activeDetector = new AdaptiveVoiceActivityDetector({
                initialNoiseFloorDb: this.activityDetector.noiseFloorDb,
                startMarginDb: this.commandSpeechStartMarginDb,
                endMarginDb: this.activityDetector.endMarginDb,
                minimumSpeechMs: this.commandMinimumSpeechMs,
                silenceDurationMs: this.activityDetector.silenceDurationMs,
                calibrationFrames: 1
              });
              this.commandExpiresAt = Date.now() + this.commandWindowMs;
              this.onCommandWindowStarted(this.commandWindowMs);
              return;
            }
            phraseEnded = true;
            requestStop();
          }, 150);
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });

    const { exitCode, exitSignal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ exitCode: code, exitSignal: signal }));
    }).finally(() => {
      clearInterval(timeout);
      clearTimeout(forceStopTimeout);
      clearTimeout(boundaryDecisionTimeout);
      if (this.process === child) this.process = null;
    });

    const commandWasArmed = this.commandExpiresAt > 0;
    const commandTimedOut = commandWasArmed && Date.now() >= this.commandExpiresAt;
    if (bridgedCommand && commandTimedOut && !commandSpeechStarted) {
      this.commandExpiresAt = 0;
      this.bridgeCurrentPhrase = false;
      return { audio: null, commandWasArmed: true, commandTimedOut: true };
    }
    if (speechStarted || commandTimedOut) this.commandExpiresAt = 0;
    this.bridgeCurrentPhrase = false;

    try {
      const expectedInterrupt = exitSignal === "SIGINT" && (stopRequested || this.paused || !this.running);
      if (exitCode !== 0 && exitCode !== 255 && !expectedInterrupt) {
        const status = exitSignal ? `señal ${exitSignal}` : `código ${exitCode}`;
        throw new Error(`ffmpeg terminó con ${status}: ${stderr.split("\n").findLast((line) => line.trim()) || "error desconocido"}`);
      }
      if (!speechStarted) return commandTimedOut ? { audio: null, commandWasArmed, commandTimedOut: true } : null;
      this.log("info", "Frase capturada", {
        reason: phraseEnded ? "adaptive_silence" : "limit",
        noiseFloorDb: Number(activeDetector.noiseFloorDb.toFixed(1)),
        bridgedCommand
      });
      const pcm = Buffer.concat(pcmChunks);
      const detectedStart = bridgedCommand ? commandSpeechStartByte : speechStartByte;
      const lowerBound = bridgedCommand ? (commandBoundaryByte ?? 0) : 0;
      const startByte = Math.max(lowerBound, (detectedStart ?? lowerBound) - this.preRollBytes) & ~1;
      return { audio: pcmToWav(pcm.subarray(startByte)), commandWasArmed, commandTimedOut: false, bridgedCommand };
    } catch (error) {
      const status = exitSignal ? `señal ${exitSignal}` : `código ${exitCode}`;
      throw new Error(`ffmpeg terminó con ${status}: ${stderr.split("\n").at(-2) || error.message}`);
    }
  }
}
