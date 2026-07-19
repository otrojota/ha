function apiMessages(messages) {
  const pendingCallIds = new Map();
  return messages.map((message) => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const toolCalls = message.tool_calls.map((call, index) => {
        const name = call.function?.name;
        const id = call.id || `call_${index}_${name || "tool"}`;
        const ids = pendingCallIds.get(name) || [];
        ids.push(id);
        pendingCallIds.set(name, ids);
        return { id, type: "function", function: { name, arguments: typeof call.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call.function?.arguments || {}) } };
      });
      return { role: "assistant", content: message.content || null, tool_calls: toolCalls };
    }
    if (message.role === "tool") {
      const ids = pendingCallIds.get(message.tool_name) || [];
      return { role: "tool", tool_call_id: message.tool_call_id || ids.shift() || `call_${message.tool_name}`, content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

export class OpenAiCompatibleClient {
  constructor({ url, apiKey, model, temperature = 0.1, timeoutMs = 120_000, headers = {} }) {
    this.url = url.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.temperature = temperature;
    this.timeoutMs = timeoutMs;
    this.headers = headers;
  }

  async chat(messages, tools = []) {
    const response = await fetch(`${this.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}), ...this.headers },
      body: JSON.stringify({ model: this.model, messages: apiMessages(messages), ...(tools.length ? { tools } : {}), stream: false, temperature: this.temperature }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`El proveedor LLM respondió HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const result = await response.json();
    const message = result.choices?.[0]?.message;
    if (!message) throw new Error("El proveedor LLM no devolvió un mensaje");
    return {
      message: {
        role: "assistant",
        content: message.content || "",
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map((call) => {
          let args = {};
          try { args = JSON.parse(call.function?.arguments || "{}"); } catch { args = {}; }
          return { id: call.id, function: { name: call.function?.name, arguments: args } };
        }) } : {})
      },
      usage: result.usage
    };
  }
}
