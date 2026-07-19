import assert from "node:assert/strict";
import test from "node:test";
import { HomeAssistantClient } from "./home-assistant-client.js";

test("autentica y llama servicios de Home Assistant", async () => {
  const calls = [];
  const client = new HomeAssistantClient({ baseUrl: "http://home:8123/", token: "token", fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => [] }; } });
  await client.callService("light", "turn_on", { entity_id: "light.living", brightness_pct: 40 });
  assert.equal(calls[0].url, "http://home:8123/api/services/light/turn_on");
  assert.equal(calls[0].options.headers.Authorization, "Bearer token");
  assert.deepEqual(JSON.parse(calls[0].options.body), { entity_id: "light.living", brightness_pct: 40 });
});

test("propaga mensajes de error de Home Assistant", async () => {
  const client = new HomeAssistantClient({ baseUrl: "http://home:8123", token: "bad", fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: "Invalid access token" }) }) });
  await assert.rejects(client.test(), /Invalid access token/);
});
