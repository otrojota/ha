import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

export function env(name, fallback) {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Falta la variable de entorno ${name}`);
}

export function configPath(systemPath, developmentPath) {
  return existsSync(dirname(systemPath)) ? systemPath : developmentPath;
}

export function jsonLog(level, message, context = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...context }));
}

export async function readReleaseVersion(releaseFileUrl, packageFileUrl) {
  try {
    const version = (await readFile(releaseFileUrl, "utf8")).trim();
    if (version) return version;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const packageJson = JSON.parse(await readFile(packageFileUrl, "utf8"));
  return String(packageJson.version || "desconocida");
}
