import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function validate(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("La identidad debe ser un objeto");
  if (typeof identity.id !== "string" || !/^[0-9a-f-]{36}$/i.test(identity.id)) throw new Error("La identidad no contiene un UUID válido");
  if (typeof identity.name !== "string" || !identity.name.trim()) throw new Error("La identidad no contiene un nombre válido");
  return { id: identity.id, name: identity.name.trim() };
}

export async function readOrCreateServerIdentity(path, { name = "Servidor del asistente", log = () => {} } = {}) {
  try {
    return validate(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Identidad del servidor inválida en ${path}: ${error.message}`);
    const identity = { id: randomUUID(), name: name.trim() || "Servidor del asistente" };
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
    log("info", "Identidad del servidor creada", identity);
    return identity;
  }
}
