import { isMeaningfulVoiceCommand, normalizeVoiceText } from "../speech/voice-command.js";
import { pcm16MonoToWav, pcmLevelDb } from "./pcm-audio.js";

const PCM_BYTES_PER_MILLISECOND = 32;
const ACTIVE_COMMAND_STATES = new Set(["listening", "follow_up_listening"]);
const INTERRUPTIBLE_STATES = new Set(["speaking"]);
const INTERRUPTION_WORDS = new Set(["stop", "detente", "alto"]);

function finite(value, fallback, minimum = -Infinity) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

function spokenTokens(text) {
  return String(text || "").match(/[\p{L}\p{N}]+/gu) || [];
}

export function findWakeWord(text, wakeWord) {
  const original = spokenTokens(text);
  const normalized = original.map((token) => normalizeVoiceText(token));
  const wake = spokenTokens(wakeWord).map((token) => normalizeVoiceText(token));
  if (!wake.length) return { found: false, command: "" };
  for (let index = 0; index <= normalized.length - wake.length; index += 1) {
    if (wake.every((token, offset) => normalized[index + offset] === token)) {
      return { found: true, command: original.slice(index + wake.length).join(" ") };
    }
  }
  return { found: false, command: "" };
}

export function containsInterruption(text) {
  return spokenTokens(text).some((token) => INTERRUPTION_WORDS.has(normalizeVoiceText(token)));
}

export class ContinuousVoiceRecognitionService {
  constructor({
    speechToText,
    voiceStates,
    sessionProvider,
    onPartial = () => {},
    onCommand = () => {},
    onInterrupt = () => {},
    onError = () => {},
    log = () => {},
    initialNoiseFloorDb = -50,
    speechStartMarginDb = 8,
    speechEndMarginDb = 5,
    minimumSpeechMs = 160,
    silenceDurationMs = 700,
    preRollMs = 300,
    partialIntervalMs = 700,
    partialMinimumMs = 700,
    maximumPhraseMs = 8_000,
    listeningTimeoutMs = 7_000
  } = {}) {
    this.speechToText = speechToText;
    this.voiceStates = voiceStates;
    this.sessionProvider = sessionProvider;
    this.onPartial = onPartial;
    this.onCommand = onCommand;
    this.onInterrupt = onInterrupt;
    this.onError = onError;
    this.log = log;
    this.initialNoiseFloorDb = finite(initialNoiseFloorDb, -50);
    this.speechStartMarginDb = finite(speechStartMarginDb, 8, 0);
    this.speechEndMarginDb = finite(speechEndMarginDb, 5, 0);
    this.minimumSpeechMs = finite(minimumSpeechMs, 160, 20);
    this.silenceDurationMs = finite(silenceDurationMs, 700, 20);
    this.preRollMs = finite(preRollMs, 300, 0);
    this.partialIntervalMs = finite(partialIntervalMs, 700, 100);
    this.partialMinimumMs = finite(partialMinimumMs, 700, this.minimumSpeechMs);
    this.maximumPhraseMs = finite(maximumPhraseMs, 8_000, this.minimumSpeechMs);
    this.listeningTimeoutMs = finite(listeningTimeoutMs, 7_000, 500);
    this.entries = new Map();
    this.nextUtteranceId = 1;
  }

  configure(satelliteId, { enabled = true, wakeWord } = {}) {
    const entry = this.#entry(satelliteId);
    entry.enabled = enabled === true;
    entry.wakeWord = String(wakeWord || "").trim();
    if (!entry.enabled || !entry.wakeWord) this.#discardUtterance(entry, "wake_word_disabled");
    return this.snapshot(satelliteId);
  }

  accept(satelliteId, session, result) {
    if (!result?.accepted || !session) return false;
    const entry = this.#entry(satelliteId);
    const state = session.state;
    const shouldRecognize = (state === "idle" && entry.enabled && entry.wakeWord)
      || ACTIVE_COMMAND_STATES.has(state)
      || INTERRUPTIBLE_STATES.has(state);
    if (!shouldRecognize) {
      this.#observeAmbient(entry, result.frame.audio);
      this.#discardUtterance(entry, "state_not_monitored");
      return false;
    }
    if (result.bufferReset) this.#discardUtterance(entry, "stream_discontinuity");
    this.#consume(entry, session, result.frame.audio);
    return true;
  }

  remove(satelliteId) {
    return this.entries.delete(String(satelliteId || "").trim());
  }

  snapshot(satelliteId) {
    const entry = this.entries.get(String(satelliteId || "").trim());
    return entry ? this.#snapshot(entry) : null;
  }

  list() {
    return [...this.entries.values()].map((entry) => this.#snapshot(entry));
  }

  #entry(satelliteId) {
    const id = String(satelliteId || "").trim();
    if (!id) throw new Error("satelliteId es obligatorio para reconocimiento continuo");
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        satelliteId: id,
        enabled: false,
        wakeWord: "",
        noiseFloorDb: this.initialNoiseFloorDb,
        ambientLevels: [],
        loudDurationMs: 0,
        utterance: null,
        jobs: [],
        inFlight: false,
        wakeUtterances: new Map(),
        partialCommands: new Map(),
        submittedUtterances: new Set(),
        lastPartialText: "",
        transcriptions: 0,
        transcriptionFailures: 0,
        lastTranscript: null,
        lastEndReason: null
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  #observeAmbient(entry, pcm) {
    const db = pcmLevelDb(pcm);
    entry.ambientLevels.push(db);
    if (entry.ambientLevels.length > 100) entry.ambientLevels.shift();
    const ordered = [...entry.ambientLevels].sort((left, right) => left - right);
    const observed = ordered[Math.floor(Math.max(0, ordered.length - 1) * 0.2)] ?? this.initialNoiseFloorDb;
    const smoothing = observed < entry.noiseFloorDb ? 0.2 : 0.03;
    entry.noiseFloorDb += (observed - entry.noiseFloorDb) * smoothing;
    entry.noiseFloorDb = Math.min(-20, Math.max(-60, entry.noiseFloorDb));
  }

  #consume(entry, session, frame) {
    const db = pcmLevelDb(frame);
    const durationMs = frame.length / PCM_BYTES_PER_MILLISECOND;
    const startThresholdDb = Math.min(-18, entry.noiseFloorDb + this.speechStartMarginDb);
    const endThresholdDb = Math.min(-22, entry.noiseFloorDb + this.speechEndMarginDb);
    if (!entry.utterance) {
      entry.loudDurationMs = db >= startThresholdDb ? entry.loudDurationMs + durationMs : 0;
      if (entry.loudDurationMs === 0) this.#observeAmbient(entry, frame);
      if (entry.loudDurationMs < this.minimumSpeechMs) return;
      const recent = session.readRecentAudio(this.preRollMs + entry.loudDurationMs);
      entry.utterance = {
        id: this.nextUtteranceId++,
        chunks: [recent],
        bytes: recent.length,
        quietDurationMs: 0,
        lastQueuedDurationMs: 0
      };
      entry.loudDurationMs = 0;
      this.log("info", "Voz detectada para STT continuo", {
        satelliteId: entry.satelliteId,
        utteranceId: entry.utterance.id,
        state: session.state,
        noiseFloorDb: Number(entry.noiseFloorDb.toFixed(1))
      });
      return;
    }
    const utterance = entry.utterance;
    utterance.chunks.push(Buffer.from(frame));
    utterance.bytes += frame.length;
    utterance.quietDurationMs = db < endThresholdDb ? utterance.quietDurationMs + durationMs : 0;
    const totalDurationMs = utterance.bytes / PCM_BYTES_PER_MILLISECOND;
    if (totalDurationMs >= this.partialMinimumMs
      && totalDurationMs - utterance.lastQueuedDurationMs >= this.partialIntervalMs) {
      utterance.lastQueuedDurationMs = totalDurationMs;
      this.#enqueue(entry, utterance, false);
    }
    if (utterance.quietDurationMs >= this.silenceDurationMs) {
      this.#finishUtterance(entry, "silence");
    } else if (totalDurationMs >= this.maximumPhraseMs) {
      this.#finishUtterance(entry, "maximum_duration");
    }
  }

  #finishUtterance(entry, reason) {
    const utterance = entry.utterance;
    if (!utterance) return;
    entry.utterance = null;
    entry.lastEndReason = reason;
    this.#enqueue(entry, utterance, true);
  }

  #enqueue(entry, utterance, final) {
    const audio = pcm16MonoToWav(Buffer.concat(utterance.chunks));
    if (final) {
      entry.jobs = entry.jobs.filter((job) => job.utteranceId !== utterance.id || job.final);
    } else {
      const queuedPartial = entry.jobs.find((job) => job.utteranceId === utterance.id && !job.final);
      if (queuedPartial) {
        queuedPartial.audio = audio;
        return;
      }
    }
    entry.jobs.push({ utteranceId: utterance.id, audio, final });
    void this.#drain(entry);
  }

  async #drain(entry) {
    if (entry.inFlight) return;
    entry.inFlight = true;
    try {
      while (entry.jobs.length && this.entries.get(entry.satelliteId) === entry) {
        const job = entry.jobs.shift();
        try {
          const transcript = String(await this.speechToText.transcribe(job.audio) || "").trim();
          entry.transcriptions += 1;
          entry.lastTranscript = transcript;
          await this.#handleTranscript(entry, job, transcript);
        } catch (error) {
          entry.transcriptionFailures += 1;
          this.log("warn", "Falló una ventana de STT continuo", {
            satelliteId: entry.satelliteId,
            utteranceId: job.utteranceId,
            final: job.final,
            error: error.message
          });
          await this.onError({ satelliteId: entry.satelliteId, ...job, error });
        }
      }
    } finally {
      entry.inFlight = false;
    }
  }

  async #handleTranscript(entry, job, transcript) {
    const session = this.sessionProvider(entry.satelliteId);
    const rememberedPartial = entry.partialCommands.get(job.utteranceId) || "";
    if (!session || (!isMeaningfulVoiceCommand(transcript) && !isMeaningfulVoiceCommand(rememberedPartial))) return;
    if (entry.submittedUtterances.has(job.utteranceId)) return;

    if (INTERRUPTIBLE_STATES.has(session.state) && containsInterruption(transcript)) {
      this.#markSubmitted(entry, job.utteranceId);
      await this.onPartial({
        satelliteId: entry.satelliteId,
        activationId: session.activationId,
        text: transcript,
        final: job.final,
        interruption: true
      });
      await this.onInterrupt({ satelliteId: entry.satelliteId, activationId: session.activationId, text: transcript });
      return;
    }

    let wakeMatch = { found: false, command: "" };
    if (session.state === "idle" && entry.enabled) {
      wakeMatch = findWakeWord(transcript, entry.wakeWord);
      if (!wakeMatch.found) return;
      const activation = this.voiceStates.activate(entry.satelliteId, {
        reason: "stt_wake_word",
        timeoutMs: this.listeningTimeoutMs,
        requestListening: false,
        metadata: { provider: "stt", wakeWord: entry.wakeWord }
      });
      if (!activation.accepted) return;
      entry.wakeUtterances.set(job.utteranceId, wakeMatch.command);
    }

    const current = this.sessionProvider(entry.satelliteId);
    if (!current || !ACTIVE_COMMAND_STATES.has(current.state)) return;
    const belongsToWakeUtterance = entry.wakeUtterances.has(job.utteranceId);
    const currentWakeMatch = belongsToWakeUtterance
      ? findWakeWord(transcript, entry.wakeWord)
      : { found: false, command: "" };
    if (belongsToWakeUtterance && currentWakeMatch.found && isMeaningfulVoiceCommand(currentWakeMatch.command)) {
      entry.wakeUtterances.set(job.utteranceId, currentWakeMatch.command);
    }
    const rememberedCommand = entry.wakeUtterances.get(job.utteranceId) || "";
    let command = belongsToWakeUtterance
      ? currentWakeMatch.found
        ? currentWakeMatch.command
        : isMeaningfulVoiceCommand(rememberedCommand)
          ? rememberedCommand
          : transcript
      : transcript;
    let displayText = belongsToWakeUtterance
      && !currentWakeMatch.found
      && isMeaningfulVoiceCommand(rememberedCommand)
      ? rememberedCommand
      : transcript;
    if (!job.final && isMeaningfulVoiceCommand(command)) {
      entry.partialCommands.set(job.utteranceId, command);
      this.voiceStates.refreshListening?.(entry.satelliteId, {
        timeoutMs: this.listeningTimeoutMs,
        reason: "stt_partial_command"
      });
    }
    const partialTokens = spokenTokens(rememberedPartial).length;
    const finalTokens = spokenTokens(command).length;
    const finalRegressed = job.final && isMeaningfulVoiceCommand(rememberedPartial)
      && (!isMeaningfulVoiceCommand(command) || (partialTokens >= 3 && partialTokens >= finalTokens + 2));
    if (finalRegressed) {
      command = rememberedPartial;
      displayText = rememberedPartial;
    }
    if (job.final && displayText !== transcript) {
      this.log("info", "Se conservó el comando reconocido antes de una regresión final de STT", {
        satelliteId: entry.satelliteId,
        utteranceId: job.utteranceId,
        finalTranscript: transcript,
        command: displayText
      });
    }
    if (displayText !== entry.lastPartialText || job.final) {
      entry.lastPartialText = displayText;
      await this.onPartial({
        satelliteId: entry.satelliteId,
        activationId: current.activationId,
        text: displayText,
        command,
        final: job.final
      });
    }
    if (!job.final) return;
    if (!isMeaningfulVoiceCommand(command)) {
      entry.wakeUtterances.delete(job.utteranceId);
      entry.partialCommands.delete(job.utteranceId);
      return;
    }
    this.#markSubmitted(entry, job.utteranceId);
    entry.wakeUtterances.delete(job.utteranceId);
    entry.partialCommands.delete(job.utteranceId);
    await this.onCommand({
      satelliteId: entry.satelliteId,
      activationId: current.activationId,
      transcript: command
    });
  }

  #discardUtterance(entry, reason) {
    if (!entry.utterance) return;
    entry.utterance = null;
    entry.loudDurationMs = 0;
    entry.lastEndReason = reason;
  }

  #markSubmitted(entry, utteranceId) {
    entry.submittedUtterances.add(utteranceId);
    while (entry.submittedUtterances.size > 100) {
      entry.submittedUtterances.delete(entry.submittedUtterances.values().next().value);
    }
  }

  #snapshot(entry) {
    return {
      satelliteId: entry.satelliteId,
      enabled: entry.enabled,
      wakeWord: entry.wakeWord,
      status: entry.inFlight ? "transcribing" : entry.utterance ? "hearing_speech" : "listening",
      noiseFloorDb: Number(entry.noiseFloorDb.toFixed(1)),
      utteranceId: entry.utterance?.id || null,
      bufferedDurationMs: entry.utterance ? Number((entry.utterance.bytes / PCM_BYTES_PER_MILLISECOND).toFixed(1)) : 0,
      queuedTranscriptions: entry.jobs.length,
      transcriptions: entry.transcriptions,
      transcriptionFailures: entry.transcriptionFailures,
      lastTranscript: entry.lastTranscript,
      lastEndReason: entry.lastEndReason
    };
  }
}
