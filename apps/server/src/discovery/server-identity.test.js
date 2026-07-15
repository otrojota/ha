import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readOrCreateServerIdentity } from "./server-identity.js";

test("crea una identidad estable y la reutiliza", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-server-identity-"));
  const path = join(directory, "identity.json");
  const first = await readOrCreateServerIdentity(path, { name: "Servidor Casa" });
  const second = await readOrCreateServerIdentity(path, { name: "Otro nombre" });
  assert.equal(first.id, second.id);
  assert.equal(second.name, "Servidor Casa");
  assert.match(first.id, /^[0-9a-f-]{36}$/);
});
