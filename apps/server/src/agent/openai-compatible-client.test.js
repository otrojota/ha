import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleClient } from "./openai-compatible-client.js";

test("traduce tools y respuestas OpenAI al formato interno del agente", async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "weather_get_current", arguments: "{\"city\":\"Valparaíso\"}" } }] } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const client = new OpenAiCompatibleClient({ url: "https://example.com/v1", apiKey: "secret", model: "model" });
    const result = await client.chat([{ role: "user", content: "clima" }], [{ type: "function", function: { name: "weather_get_current", parameters: { type: "object" } } }]);
    assert.equal(request.model, "model");
    assert.equal(request.tools[0].function.name, "weather_get_current");
    assert.deepEqual(result.message.tool_calls[0].function.arguments, { city: "Valparaíso" });
  } finally {
    global.fetch = originalFetch;
  }
});

test("asocia el resultado de una tool con el id solicitado por OpenAI", async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Listo" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const client = new OpenAiCompatibleClient({ url: "https://example.com/v1", model: "model" });
    await client.chat([
      { role: "assistant", content: "", tool_calls: [{ id: "call_weather", function: { name: "weather_get_current", arguments: {} } }] },
      { role: "tool", tool_name: "weather_get_current", content: "{\"temperature\":12}" }
    ]);
    assert.equal(request.messages[1].tool_call_id, "call_weather");
  } finally {
    global.fetch = originalFetch;
  }
});
