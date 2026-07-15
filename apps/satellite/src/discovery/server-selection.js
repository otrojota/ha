import { readSatelliteServerConfig, writeSatelliteServerConfig } from "../config/server-config.js";

export function serverFromManualUrl(webSocketUrl, speechToTextUrl) {
  const ws = new URL(webSocketUrl);
  if (!["ws:", "wss:"].includes(ws.protocol)) throw new Error("SERVER_URL debe usar ws o wss");
  const httpProtocol = ws.protocol === "wss:" ? "https:" : "http:";
  const httpUrl = `${httpProtocol}//${ws.host}`;
  return {
    id: "manual", name: "Servidor configurado manualmente", address: ws.hostname, host: ws.hostname,
    port: Number(ws.port || (ws.protocol === "wss:" ? 443 : 80)), protocolVersion: "1",
    httpUrl, webSocketUrl: ws.toString(),
    speechToTextUrl: speechToTextUrl || `${httpUrl}/stt/transcribe`,
    musicApiUrl: `${httpProtocol}//${ws.hostname}:3100/v1`, available: true, manual: true
  };
}

export class ServerSelection {
  constructor({ discovery, configPath, manualServer = null, onSelected = () => {}, log = () => {} }) {
    this.discovery = discovery;
    this.configPath = configPath;
    this.manualServer = manualServer;
    this.onSelected = onSelected;
    this.log = log;
    this.selectedServerId = null;
    this.activeServer = null;
  }

  async start() {
    const persisted = await readSatelliteServerConfig(this.configPath, this.log);
    this.selectedServerId = persisted.selectedServerId || this.manualServer?.id || null;
    this.discovery.onChanged = () => { void this.reconcile(); };
    this.discovery.start();
    await this.reconcile();
  }

  list() {
    return [
      ...(this.manualServer ? [this.manualServer] : []),
      ...this.discovery.list().filter((server) => server.id !== this.manualServer?.id)
    ];
  }

  state() {
    return {
      mode: "automatic",
      manualConfigured: Boolean(this.manualServer),
      selectedServerId: this.selectedServerId,
      selected: this.activeServer,
      discovered: this.list(),
      selectionRequired: !this.activeServer && this.list().length > 1
    };
  }

  async reconcile() {
    const servers = this.list();
    let next = servers.find((server) => server.id === this.selectedServerId) || null;
    if (!next && !this.selectedServerId && servers.length === 1) {
      next = servers[0];
      this.selectedServerId = next.id;
      await writeSatelliteServerConfig(this.configPath, { selectedServerId: next.id });
      this.log("info", "Único servidor seleccionado automáticamente", { id: next.id, name: next.name });
    }
    if (this.activeServer?.id !== next?.id || this.activeServer?.address !== next?.address || this.activeServer?.port !== next?.port) {
      this.activeServer = next;
      this.onSelected(next);
    }
  }

  async select(id) {
    const server = this.list().find((item) => item.id === id);
    if (!server) throw new Error("El servidor seleccionado no está disponible");
    this.selectedServerId = server.id;
    await writeSatelliteServerConfig(this.configPath, { selectedServerId: server.id });
    await this.reconcile();
    return this.state();
  }

  refresh() { this.discovery.refresh(); return this.state(); }
  stop() { this.discovery.stop(); }
}
