export class WakeActivationGate {
  constructor() { this.phase = "idle"; }
  get active() { return this.phase !== "idle"; }
  beginListening() {
    if (this.active) return false;
    this.phase = "listening";
    return true;
  }
  keepListening() { this.phase = "listening"; }
  beginProcessing() { if (this.active) this.phase = "processing"; }
  end() { this.phase = "idle"; }
}

export class OneShotCommandRetry {
  constructor() { this.available = false; }
  reset() { this.available = true; }
  consume() {
    if (!this.available) return false;
    this.available = false;
    return true;
  }
  clear() { this.available = false; }
}
