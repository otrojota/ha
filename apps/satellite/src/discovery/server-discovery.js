import { isIP } from "node:net";
import { Bonjour } from "bonjour-service";
import { PROTOCOL_VERSION } from "@ha/contracts";

export const ASSISTANT_SERVICE_TYPE = "ha-assistant";

function usableAddress(address) {
  return isIP(address) === 4 && !address.startsWith("127.") && !address.startsWith("169.254.");
}

function sameIpv4Subnet(left, right) {
  if (!usableAddress(left) || !usableAddress(right)) return false;
  return left.split(".").slice(0, 3).join(".") === right.split(".").slice(0, 3).join(".");
}

function selectAdvertisedAddress(service) {
  const receiverAddress = service.referer?.address;
  const advertised = [...new Set(service.addresses || [])].filter(usableAddress);
  return advertised.find((address) => sameIpv4Subnet(address, receiverAddress))
    || advertised[0]
    || (usableAddress(receiverAddress) ? receiverAddress : null);
}

export function normalizeDiscoveredServer(service) {
  const id = String(service.txt?.id || "").trim();
  if (String(service.txt?.protocolVersion || "") !== PROTOCOL_VERSION) return null;
  const port = Number(service.port);
  const address = selectAdvertisedAddress(service);
  if (!id || !address || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const name = String(service.txt?.name || "").trim();
  if (!name) return null;
  return {
    id, name, address, port, protocolVersion: PROTOCOL_VERSION,
    httpUrl: `http://${address}:${port}`,
    webSocketUrl: `ws://${address}:${port}/ws`,
    speechToTextUrl: `http://${address}:${port}/stt/transcribe`,
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
