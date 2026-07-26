export class MusicGatewayClient {
  constructor({ baseUrl = "http://localhost:3100", fetchImpl = fetch, timeoutMs = 90_000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, options = {}, satelliteId) {
    const scope = String(satelliteId || "").trim();
    if (!scope && path !== "/health" && !path.startsWith("/v1/integration/")) throw new Error("Falta satelliteId para consultar Music Gateway");
    const scopeHeader = scope ? { "X-Satellite-Id": scope } : {};
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...scopeHeader, ...options.headers },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `Music Gateway respondió HTTP ${response.status}`);
    return result;
  }

  getDestinations(satelliteId) { return this.request("/v1/destinations", {}, satelliteId); }
  getSources(satelliteId) { return this.request("/v1/sources", {}, satelliteId); }
  setActiveSource(target, satelliteId) { return this.request("/v1/sources/active", { method: "PUT", body: JSON.stringify({ target }) }, satelliteId); }
  setActiveDestination(target, satelliteId) { return this.request("/v1/destinations/active", { method: "PUT", body: JSON.stringify({ target }) }, satelliteId); }
  play(command, satelliteId) { return this.request("/v1/music/play", { method: "POST", body: JSON.stringify(command) }, satelliteId); }
  pause(destination, satelliteId) { return this.command("pause", { destination }, satelliteId); }
  getPlayback(destination, satelliteId) {
    const query = destination ? `?destination=${encodeURIComponent(destination)}` : "";
    return this.request(`/v1/music/playback${query}`, {}, satelliteId);
  }
  getLibraryRadios(satelliteId) { return this.request("/v1/music/radios", {}, satelliteId); }
  getLibraryPlaylists(satelliteId) { return this.request("/v1/music/playlists", {}, satelliteId); }
  resume(destination, satelliteId) { return this.command("resume", { destination }, satelliteId); }
  next(destination, satelliteId) { return this.command("next", { destination }, satelliteId); }
  previous(destination, satelliteId) { return this.command("previous", { destination }, satelliteId); }
  setVolume(volumePercent, destination, changePercent, satelliteId) { return this.command("volume", { volumePercent, changePercent, destination }, satelliteId); }
  addToQueue(query, destination, satelliteId) { return this.command("queue", { query, destination }, satelliteId); }
  getQueue(destination, satelliteId) {
    const query = destination ? `?destination=${encodeURIComponent(destination)}` : "";
    return this.request(`/v1/music/queue${query}`, {}, satelliteId);
  }
  clearQueue(satelliteId) { return this.request("/v1/music/queue", { method: "DELETE" }, satelliteId); }
  getCurrentCredits(satelliteId) { return this.request("/v1/music/credits", {}, satelliteId); }
  transfer(destination, play = true, satelliteId) { return this.command("transfer", { destination, play }, satelliteId); }
  command(action, body, satelliteId) { return this.request(`/v1/music/${action}`, { method: "POST", body: JSON.stringify(body) }, satelliteId); }
}
