export class MusicGatewayClient {
  constructor({ baseUrl = "http://localhost:3100", fetchImpl = fetch, timeoutMs = 90_000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `Music Gateway respondió HTTP ${response.status}`);
    return result;
  }

  getDestinations() { return this.request("/v1/destinations"); }
  getSources() { return this.request("/v1/sources"); }
  setActiveSource(query) { return this.request("/v1/sources/active", { method: "PUT", body: JSON.stringify({ query }) }); }
  setActiveDestination(query) { return this.request("/v1/destinations/active", { method: "PUT", body: JSON.stringify({ query }) }); }
  play(command) { return this.request("/v1/music/play", { method: "POST", body: JSON.stringify(command) }); }
  pause(destination) { return this.request("/v1/music/pause", { method: "POST", body: JSON.stringify({ destination }) }); }
  getPlayback() { return this.request("/v1/music/playback"); }
  resume(destination) { return this.command("resume", { destination }); }
  next(destination) { return this.command("next", { destination }); }
  previous(destination) { return this.command("previous", { destination }); }
  setVolume(volumePercent, destination, changePercent) { return this.command("volume", { volumePercent, changePercent, destination }); }
  addToQueue(query, destination) { return this.command("queue", { query, destination }); }
  getQueue() { return this.request("/v1/music/queue"); }
  clearQueue() { return this.request("/v1/music/queue", { method: "DELETE" }); }
  getCurrentCredits() { return this.request("/v1/music/credits"); }
  transfer(destination, play = true) { return this.command("transfer", { destination, play }); }
  command(action, body) { return this.request(`/v1/music/${action}`, { method: "POST", body: JSON.stringify(body) }); }
}
