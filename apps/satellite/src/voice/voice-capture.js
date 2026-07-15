import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function captureInput(deviceId) {
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
    onAudio = () => {},
    onLevel = () => {},
    log,
    silenceDuration = 0.8,
    maxPhraseSeconds = 15,
    noiseFloorDb = -50,
    speechStartMarginDb = 10,
    speechEndMarginDb = 6
  }) {
    this.readConfig = readConfig;
    this.onPhrase = onPhrase;
    this.onListeningTimeout = onListeningTimeout;
    this.onAudio = onAudio;
    this.onLevel = onLevel;
    this.log = log;
    this.silenceDuration = silenceDuration;
    this.maxPhraseSeconds = maxPhraseSeconds;
    this.commandExpiresAt = 0;
    this.activityDetector = new AdaptiveVoiceActivityDetector({
      initialNoiseFloorDb: noiseFloorDb,
      startMarginDb: speechStartMarginDb,
      endMarginDb: speechEndMarginDb,
      silenceDurationMs: silenceDuration * 1000
    });
    this.running = false;
    this.paused = false;
    this.process = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop().catch((error) => this.log("warn", "Captura de voz detenida", { error: error.message }));
  }

  stop() {
    this.running = false;
    this.paused = true;
    this.process?.kill("SIGINT");
  }

  pause() {
    this.paused = true;
    this.process?.kill("SIGINT");
  }

  resume() {
    if (this.running) this.paused = false;
  }

  arm(commandWindowMs) {
    this.commandExpiresAt = Date.now() + commandWindowMs;
  }

  async loop() {
    let consecutiveFailures = 0;
    while (this.running) {
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
        if (!this.paused && capture?.audio?.length > 8_000) {
          await this.onPhrase(capture.audio, { commandWasArmed: capture.commandWasArmed });
        } else if (!this.paused && capture?.commandTimedOut) {
          await this.onListeningTimeout();
        }
      } catch (error) {
        if (this.paused || !this.running) continue;
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
    const outputPath = join(tmpdir(), `ha-voice-${randomUUID()}.wav`);
    const filter = `[0:a]pan=mono|c0=c${channel},aresample=16000,asplit=2[record][meter]`;
    const args = [
      "-hide_banner", "-loglevel", "info", ...input,
      "-filter_complex", filter,
      "-map", "[record]", "-ac", "1", "-c:a", "pcm_s16le", "-y", outputPath,
      "-map", "[meter]", "-ac", "1", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"
    ];

    let speechStarted = false;
    let phraseEnded = false;
    let stderr = "";
    this.activityDetector.resetPhrase();
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = child;
    const captureExpiresAt = Date.now() + this.maxPhraseSeconds * 1000;
    let stopRequested = false;
    let forceStopTimeout = null;
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
        const activity = this.activityDetector.process(db, durationMs);
        speechStarted ||= activity.speechStarted;
        this.onLevel({ db: Number(db.toFixed(1)), level: Math.min(1, Math.max(0, (db + 60) / 60)), clipping: peak >= 32760 });
        sumSquares = 0;
        sampleCount = 0;
        peak = 0;
        if (activity.phraseEnded) {
          phraseEnded = true;
          requestStop();
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
      if (this.process === child) this.process = null;
    });

    const commandWasArmed = this.commandExpiresAt > 0;
    const commandTimedOut = commandWasArmed && Date.now() >= this.commandExpiresAt;
    if (speechStarted || commandTimedOut) this.commandExpiresAt = 0;

    try {
      const expectedInterrupt = exitSignal === "SIGINT" && (stopRequested || this.paused || !this.running);
      if (exitCode !== 0 && exitCode !== 255 && !expectedInterrupt) {
        const status = exitSignal ? `señal ${exitSignal}` : `código ${exitCode}`;
        throw new Error(`ffmpeg terminó con ${status}: ${stderr.split("\n").findLast((line) => line.trim()) || "error desconocido"}`);
      }
      if (!speechStarted) return commandTimedOut ? { audio: null, commandWasArmed, commandTimedOut: true } : null;
      this.log("info", "Frase capturada", {
        reason: phraseEnded ? "adaptive_silence" : "limit",
        noiseFloorDb: Number(this.activityDetector.noiseFloorDb.toFixed(1))
      });
      return { audio: await readFile(outputPath), commandWasArmed, commandTimedOut: false };
    } catch (error) {
      const status = exitSignal ? `señal ${exitSignal}` : `código ${exitCode}`;
      throw new Error(`ffmpeg terminó con ${status}: ${stderr.split("\n").at(-2) || error.message}`);
    } finally {
      await unlink(outputPath).catch(() => {});
    }
  }
}
