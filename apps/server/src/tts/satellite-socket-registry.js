import { WebSocket } from "ws";

export class SatelliteSocketRegistry {
  constructor() {
    this.sockets = new Map();
  }

  register(satelliteId, socket) {
    const id = String(satelliteId || "").trim();
    if (!id) throw new Error("satelliteId es obligatorio");
    const previous = this.sockets.get(id);
    this.sockets.set(id, socket);
    socket.satelliteId = id;
    if (previous && previous !== socket && previous.readyState === WebSocket.OPEN) previous.close(4001, "Conexión reemplazada");
  }

  remove(socket) {
    if (socket?.satelliteId && this.sockets.get(socket.satelliteId) === socket) this.sockets.delete(socket.satelliteId);
  }

  get(satelliteId) {
    const socket = this.sockets.get(String(satelliteId || "").trim());
    return socket?.readyState === WebSocket.OPEN ? socket : null;
  }
}
