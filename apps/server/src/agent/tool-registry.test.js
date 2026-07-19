import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "./tool-registry.js";

const tool = {
  definition: { type: "function", function: {
    name: "volume", parameters: { type: "object", required: ["value"], additionalProperties: false, properties: {
      value: { type: "integer", minimum: 0, maximum: 100 }
    } }
  } },
  execute: async ({ value }) => value
};

test("valida los argumentos estructurados antes de ejecutar una tool", async () => {
  const registry = new ToolRegistry([tool]);
  assert.equal(await registry.execute("volume", { value: 50 }), 50);
  await assert.rejects(registry.execute("volume", { value: 120 }), /no puede ser mayor/);
  await assert.rejects(registry.execute("volume", { value: 50, extra: true }), /desconocido/);
});

test("acepta argumentos internos declarados sin exponerlos en la definición del LLM", async () => {
  let received;
  const registry = new ToolRegistry([{
    definition: { type: "function", function: {
      name: "music_play",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }
    } },
    internalParameters: { mediaUri: { type: "string" } },
    execute: async (args) => { received = args; return { ok: true }; }
  }]);

  assert.equal(registry.definitions()[0].function.parameters.properties.mediaUri, undefined);
  await registry.execute("music_play", { query: "Pink Floyd", mediaUri: "library://artist/42" });
  assert.deepEqual(received, { query: "Pink Floyd", mediaUri: "library://artist/42" });
  await assert.rejects(registry.execute("music_play", { query: "Pink Floyd", unexpected: true }), /Argumento desconocido: unexpected/);
});
