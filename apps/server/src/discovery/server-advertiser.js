import { Bonjour } from "bonjour-service";

export const ASSISTANT_SERVICE_TYPE = "ha-assistant";

export class ServerAdvertiser {
  constructor({ identity, port, log = () => {}, bonjour = null }) {
    this.identity = identity;
    this.port = port;
    this.log = log;
    const onNetworkError = (error) => this.log("warn", "Error de red en el anuncio mDNS", { error: error.message });
    this.bonjour = bonjour || new Bonjour(undefined, onNetworkError);
    this.bonjour.server?.mdns?.on("error", onNetworkError);
    this.bonjour.server?.mdns?.on("warning", onNetworkError);
    this.service = null;
  }

  start() {
    if (this.service) return;
    this.service = this.bonjour.publish({
      name: `${this.identity.name} [${this.identity.id.slice(0, 8)}]`,
      // Do not publish the operating system hostname. On macOS that competes
      // with mDNSResponder and can make the system rename MacBook-Pro.local.
      host: `ha-server-${this.identity.id.slice(0, 8)}.local`,
      type: ASSISTANT_SERVICE_TYPE,
      protocol: "tcp",
      port: this.port,
      txt: {
        id: this.identity.id,
        name: this.identity.name,
        protocolVersion: "1",
        wsPath: "/ws",
        sttPath: "/stt/transcribe"
      }
    });
    this.service.on("up", () => this.log("info", "Servidor anunciado por mDNS", {
      id: this.identity.id, name: this.identity.name, port: this.port, type: ASSISTANT_SERVICE_TYPE
    }));
    this.service.on("error", (error) => this.log("warn", "No se pudo anunciar el servidor por mDNS", { error: error.message }));
  }

  stop() {
    this.service?.stop?.();
    this.service = null;
    this.bonjour.destroy();
  }
}
