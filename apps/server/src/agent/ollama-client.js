export class OllamaClient {
  constructor({ url, model, think = false, keepAlive = "30m", temperature = 0.1, contextLength = 8192 }) {
    this.url = url.replace(/\/$/, "");
    this.model = model;
    this.think = think;
    this.keepAlive = keepAlive;
    this.temperature = temperature;
    this.contextLength = contextLength;
  }

  async chat(messages, tools) {
    const response = await fetch(`${this.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools,
        stream: false,
        think: this.think,
        keep_alive: this.keepAlive,
        options: { temperature: this.temperature, num_ctx: this.contextLength }
      }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new Error(`Ollama respondió HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return response.json();
  }
}
