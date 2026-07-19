import { CoreAudioTextToSpeech } from "./coreaudio-text-to-speech.js";
import { PipeWirePiperTextToSpeech } from "./pipewire-piper-text-to-speech.js";
import { SimulatedTextToSpeech } from "./simulated-text-to-speech.js";

export function createTextToSpeechProvider(log) {
  if (process.platform === "darwin") return new CoreAudioTextToSpeech();
  if (process.platform === "linux") return new PipeWirePiperTextToSpeech({
    modelsPath: process.env.PIPER_MODELS_PATH || "/var/lib/ha/models/piper",
    executable: process.env.PIPER_EXECUTABLE || "piper",
    pythonExecutable: process.env.PIPER_PYTHON || process.env.VOSK_PYTHON || "/opt/ha/venvs/satellite/bin/python"
  });
  return new SimulatedTextToSpeech(log);
}
