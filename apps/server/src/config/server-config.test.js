import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { readServerConfig, validateHomeAssistantConfig, validateLlmConfig } from "./server-config.js";

test("valida Ollama y conserva sus opciones locales", () => {
  const config = validateLlmConfig({ provider: "ollama", baseUrl: "http://localhost:11434/", model: "qwen", think: true, keepAlive: "10m" });
  assert.equal(config.baseUrl, "http://localhost:11434");
  assert.equal(config.think, true);
  assert.equal(config.keepAlive, "10m");
});

test("valida y normaliza la URL de Home Assistant", () => {
  assert.deepEqual(validateHomeAssistantConfig({ baseUrl: "http://localhost:8123/" }), { enabled: false, baseUrl: "http://localhost:8123", timeoutMs: 10000 });
  assert.equal(validateHomeAssistantConfig({ enabled: true }).enabled, true);
});

test("normaliza proveedores externos sin exponer secretos", () => {
  const config = validateLlmConfig({ provider: "openai", model: "gpt-4.1-mini" });
  assert.equal(config.baseUrl, "https://api.openai.com/v1");
  assert.equal("apiKey" in config, false);
  assert.equal(config.think, false);
});

test("rechaza archivos parciales y campos históricos", async () => {
  const path = `/tmp/ha-server-config-${process.pid}-${Date.now()}.json`;
  await writeFile(path, JSON.stringify({ locale: "es-CL", legacyProvider: true }));
  await assert.rejects(() => readServerConfig(path), /debe contener exactamente/);
});
