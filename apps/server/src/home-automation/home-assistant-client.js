import WebSocket from "ws";

export class HomeAssistantClient {
  constructor({ baseUrl, token, timeoutMs = 10000, fetchImpl = fetch }) {
    this.baseUrl = String(baseUrl || "").replace(/\/$/, "");
    this.token = String(token || "").trim();
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async request(path, { method = "GET", body } = {}) {
    if (!this.baseUrl || !this.token) throw new Error("La conexión con Home Assistant no está configurada");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || `Home Assistant respondió HTTP ${response.status}`);
      return result;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Home Assistant no respondió dentro del tiempo esperado");
      throw error;
    } finally { clearTimeout(timer); }
  }

  async test() { await this.request("/api/"); return true; }
  states() { return this.request("/api/states"); }
  state(entityId) { return this.request(`/api/states/${encodeURIComponent(entityId)}`); }
  callService(domain, service, data) { return this.request(`/api/services/${domain}/${service}`, { method: "POST", body: data }); }

  websocketCommand(type) {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/websocket`;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.terminate(); reject(new Error(`Home Assistant no respondió a ${type}`)); }, this.timeoutMs);
      let authenticated = false;
      const finish = (error, value) => {
        clearTimeout(timer);
        socket.close();
        if (error) reject(error); else resolve(value);
      };
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
          else if (message.type === "auth_invalid") finish(new Error(message.message || "Home Assistant rechazó el token"));
          else if (message.type === "auth_ok" && !authenticated) {
            authenticated = true;
            socket.send(JSON.stringify({ id: 1, type }));
          } else if (message.id === 1 && message.type === "result") {
            finish(message.success ? null : new Error(message.error?.message || `Home Assistant rechazó ${type}`), message.result || []);
          }
        } catch (error) { finish(error); }
      });
      socket.on("error", (error) => finish(error));
    });
  }
}
