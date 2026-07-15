import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readSatelliteServerConfig(path, log = () => {}) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return { selectedServerId: typeof value.selectedServerId === "string" ? value.selectedServerId : null };
  } catch (error) {
    if (error.code !== "ENOENT") log("warn", "No se pudo leer la selección de servidor", { path, error: error.message });
    return { selectedServerId: null };
  }
}

export async function writeSatelliteServerConfig(path, config) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ selectedServerId: config.selectedServerId || null }, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}
