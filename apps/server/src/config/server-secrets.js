import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readServerSecrets(path, log = () => {}) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("debe ser un objeto");
    return {
      llm: parsed.llm && typeof parsed.llm === "object" && !Array.isArray(parsed.llm) ? parsed.llm : {},
      homeAssistant: parsed.homeAssistant && typeof parsed.homeAssistant === "object" && !Array.isArray(parsed.homeAssistant) ? parsed.homeAssistant : {}
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      log("info", "No existe el archivo de secretos del servidor; se iniciará sin credenciales externas", { path });
      return { llm: {}, homeAssistant: {} };
    }
    throw new Error(`Secretos del servidor inválidos en ${path}: ${error.message}`);
  }
}

export async function writeServerSecrets(path, secrets) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}
