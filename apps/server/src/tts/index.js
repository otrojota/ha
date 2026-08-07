import { KokoroStreamingTts } from "./kokoro-streaming-tts.js";

export function createStreamingTtsProvider({ log = () => {} } = {}) {
  return new KokoroStreamingTts({
    pythonExecutable: process.env.KOKORO_PYTHON || "/opt/ha/venvs/kokoro/bin/python",
    device: process.env.KOKORO_DEVICE || "auto",
    log
  });
}
