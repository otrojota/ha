export class MusicGateway {
  constructor(provider) {
    this.provider = provider;
  }

  getPlayback() { return this.provider.getPlayback(); }
  play(request) { return this.provider.play(request); }
  pause() { return this.provider.pause(); }
}

export class SimulatorMusicProvider {
  #state = { status: "idle", item: null, device: "simulator" };

  getPlayback() { return this.#state; }
  play({ query = "Audio de prueba", device = "simulator" } = {}) {
    this.#state = { status: "playing", item: { title: query, provider: "simulator" }, device };
    return this.#state;
  }
  pause() {
    this.#state = { ...this.#state, status: "paused" };
    return this.#state;
  }
}

