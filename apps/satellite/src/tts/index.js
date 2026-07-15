import { CoreAudioTextToSpeech } from "./coreaudio-text-to-speech.js";
import { PipeWirePiperTextToSpeech } from "./pipewire-piper-text-to-speech.js";
import { SimulatedTextToSpeech } from "./simulated-text-to-speech.js";

export function createTextToSpeechProvider(log) {
  if (process.platform === "darwin") return new CoreAudioTextToSpeech();
  if (process.platform === "linux") return new PipeWirePiperTextToSpeech();
  return new SimulatedTextToSpeech(log);
}
