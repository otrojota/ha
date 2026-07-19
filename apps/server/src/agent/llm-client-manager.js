import { OllamaClient } from "./ollama-client.js";
import { OpenAiCompatibleClient } from "./openai-compatible-client.js";

export function createLlmClient(config, secrets = {}) {
  if (config.provider === "ollama") {
    return new OllamaClient({ url: config.baseUrl, model: config.model, think: config.think, keepAlive: config.keepAlive, temperature: config.temperature, contextLength: config.contextLength });
  }
  return new OpenAiCompatibleClient({
    url: config.baseUrl,
    model: config.model,
    apiKey: secrets.apiKey,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    headers: config.provider === "github-models" ? { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" } : {}
  });
}

export async function testLlmClient(client) {
  const toolName = "assistant_configuration_test";
  const result = await client.chat([
    { role: "system", content: `Para comprobar la configuración debes llamar exactamente a la herramienta ${toolName}. No respondas con texto.` },
    { role: "user", content: "Comprueba la conexión y el uso de herramientas." }
  ], [{
    type: "function",
    function: {
      name: toolName,
      description: "Confirma que el modelo configurado puede solicitar herramientas.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  }]);
  if (!result.message?.tool_calls?.some((call) => call.function?.name === toolName)) {
    throw new Error("El modelo respondió, pero no confirmó compatibilidad con tool calling");
  }
  return result;
}

export class LlmClientManager {
  constructor(client) { this.client = client; }
  chat(messages, tools) { return this.client.chat(messages, tools); }
  activate(client) { this.client = client; }
}
