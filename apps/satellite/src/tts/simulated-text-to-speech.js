import { TextToSpeechProvider } from "./text-to-speech-provider.js";

export class SimulatedTextToSpeech extends TextToSpeechProvider {
  constructor(log) {
    super("simulated");
    this.log = log;
  }

  async listVoices() {
    return [{ id: "simulated-es", name: "Voz simulada · es", language: "es" }];
  }

  async speak(text, options) {
    this.log("info", "TTS simulado", { text, ...options });
  }
}
