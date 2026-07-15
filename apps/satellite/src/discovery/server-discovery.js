import { isIP } from "node:net";
import { Bonjour } from "bonjour-service";

export const ASSISTANT_SERVICE_TYPE = "ha-assistant";

function usableAddress(address) {
  return isIP(address) === 4 && !address.startsWith("127.") && !address.startsWith("169.254.");
}

export function normalizeDiscoveredServer(service) {
  const id = String(service.txt?.id || "").trim();
  const port = Number(service.port);
  const address = [service.referer?.address, ...(service.addresses || [])].find(usableAddress);
  if (!id || !address || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const name = String(service.txt?.name || service.name || "Servidor del asistente").trim();
  const wsPath = String(service.txt?.wsPath || "/ws");
  const sttPath = String(service.txt?.sttPath || "/stt/transcribe");
  return {
    id, name, address, host: service.host || null, port,
    protocolVersion: String(service.txt?.protocolVersion || "1"),
    httpUrl: `http://${address}:${port}`,
    webSocketUrl: `ws://${address}:${port}${wsPath.startsWith("/") ? wsPath : `/${wsPath}`}`,
    speechToTextUrl: `http://${address}:${port}${sttPath.startsWith("/") ? sttPath : `/${sttPath}`}`,
    musicApiUrl: `http://${address}:3100/v1`,
    available: true
  };
}

export class ServerDiscovery {
  constructor({ onChanged = () => {}, log = () => {}, bonjour = null } = {}) {
    this.onChanged = onChanged;
    this.log = log;
    const onNetworkError = (error) => this.log("warn", "Error de red durante el descubrimiento mDNS", { error: error.message });
    this.bonjour = bonjour || new Bonjour(undefined, onNetworkError);
    this.bonjour.server?.mdns?.on("error", onNetworkError);
    this.bonjour.server?.mdns?.on("warning", onNetworkError);
    this.browser = null;
    this.servers = new Map();
  }

  start() {
    if (this.browser) return;
    this.browser = this.bonjour.find({ type: ASSISTANT_SERVICE_TYPE, protocol: "tcp" });
    this.browser.on("up", (service) => {
      const server = normalizeDiscoveredServer(service);
      if (!server) return;
      this.servers.set(server.id, server);
      this.log("info", "Servidor descubierto por mDNS", { id: server.id, name: server.name, address: server.address, port: server.port });
      this.onChanged(this.list());
    });
    this.browser.on("down", (service) => {
      const id = String(service.txt?.id || "").trim();
      if (id && this.servers.delete(id)) {
        this.log("warn", "Servidor mDNS dejó de estar disponible", { id });
        this.onChanged(this.list());
      }
    });
  }

  refresh() { this.browser?.update(); }
  list() { return [...this.servers.values()].sort((left, right) => left.name.localeCompare(right.name)); }
  stop() { this.browser?.stop(); this.browser = null; this.bonjour.destroy(); }
}
