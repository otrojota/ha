import { readSatelliteServerConfig, writeSatelliteServerConfig } from "../config/server-config.js";

export class ServerSelection {
  constructor({ discovery, configPath, onSelected = () => {}, log = () => {} }) {
    this.discovery = discovery;
    this.configPath = configPath;
    this.onSelected = onSelected;
    this.log = log;
    this.selectedServerId = null;
    this.lastServer = null;
    this.activeServer = null;
  }

  async start() {
    const persisted = await readSatelliteServerConfig(this.configPath, this.log);
    this.selectedServerId = persisted.selectedServerId;
    this.lastServer = persisted.lastServer || null;
    this.discovery.onChanged = () => { void this.reconcile(); };
    this.discovery.start();
    await this.reconcile();
  }

  list() {
    const live = this.discovery.list();
    if (this.lastServer && !live.some((server) => server.id === this.lastServer.id)) {
      live.push({ ...this.lastServer, available: false, cached: true });
    }
    return live;
  }

  state() {
    return {
      selectedServerId: this.selectedServerId,
      selected: this.activeServer,
      discovered: this.list(),
      selectionRequired: !this.activeServer && this.list().length > 1
    };
  }

  async reconcile() {
    const servers = this.list();
    let next = servers.find((server) => server.id === this.selectedServerId) || null;
    let selectedAutomatically = false;
    if (!next && !this.selectedServerId && servers.length === 1) {
      next = servers[0];
      this.selectedServerId = next.id;
      selectedAutomatically = true;
      this.log("info", "Único servidor seleccionado automáticamente", { id: next.id, name: next.name });
    }
    if (this.activeServer?.id !== next?.id || this.activeServer?.address !== next?.address || this.activeServer?.port !== next?.port) {
      this.activeServer = next;
      this.onSelected(next);
    }
    if (next && !next.cached && (selectedAutomatically
      || this.lastServer?.address !== next.address || this.lastServer?.port !== next.port
      || this.lastServer?.webSocketUrl !== next.webSocketUrl)) {
      this.lastServer = next;
      await writeSatelliteServerConfig(this.configPath, { selectedServerId: this.selectedServerId, lastServer: next });
    }
  }

  async select(id) {
    const server = this.list().find((item) => item.id === id);
    if (!server) throw new Error("El servidor seleccionado no está disponible");
    this.selectedServerId = server.id;
    this.lastServer = server;
    await writeSatelliteServerConfig(this.configPath, { selectedServerId: server.id, lastServer: server });
    await this.reconcile();
    return this.state();
  }

  refresh() { this.discovery.refresh(); return this.state(); }
  stop() { this.discovery.stop(); }
}
