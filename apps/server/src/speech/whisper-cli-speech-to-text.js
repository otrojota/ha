import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class WhisperCliSpeechToText {
  constructor({ executable = "whisper-cli", modelPath, language = "es", noGpu = false }) {
    this.executable = executable;
    this.modelPath = modelPath;
    this.language = language;
    this.noGpu = noGpu;
  }

  async transcribe(audio) {
    if (!this.modelPath) throw new Error("Falta configurar WHISPER_MODEL_PATH");
    const directory = await mkdtemp(join(tmpdir(), "ha-stt-"));
    const audioPath = join(directory, "phrase.wav");
    const outputPath = join(directory, "transcript");
    try {
      await writeFile(audioPath, audio);
      const arguments_ = [
        "-m", this.modelPath, "-f", audioPath, "-l", this.language,
        "-otxt", "-of", outputPath, "-np", "-nt"
      ];
      if (this.noGpu) arguments_.unshift("-ng");
      await execFileAsync(this.executable, arguments_, { timeout: 120_000, maxBuffer: 2_000_000 });
      return (await readFile(`${outputPath}.txt`, "utf8")).trim();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
