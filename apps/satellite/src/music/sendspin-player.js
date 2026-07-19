import { spawn } from "node:child_process";

export class SendspinPlayer {
  constructor({ executable = "sendspin", satelliteId, serverUrl = "", log = () => {} }) {
    this.executable = executable;
    this.satelliteId = satelliteId;
    this.serverUrl = serverUrl;
    this.log = log;
    this.process = null;
    this.stopping = false;
    this.lastError = null;
    this.stoppedProcesses = new WeakSet();
  }

  async start(config = {}) {
    this.stop();
    if (config.musicPlayerEnabled === false) {
      this.lastError = null;
      this.log("info", "Reproductor Music Assistant deshabilitado");
      return this.status(config);
    }
    // Este nombre sólo sirve para el primer registro de un clientId estable.
    // El nombre visible y editable es propiedad de Music Assistant.
    const name = String(config.registrationName || "").trim() || `HA Satellite ${this.satelliteId}`;
    const args = ["daemon", "--id", `ha-${this.satelliteId}`, "--name", name, "--manufacturer", "HA Voice Assistant", "--product-name", "Satellite Speaker"];
    const device = String(config.musicOutputDeviceId || "").trim();
    if (device) args.push("--audio-device", device);
    if (this.serverUrl) args.push("--url", this.serverUrl);
    this.stopping = false;
    this.lastError = null;
    const child = spawn(this.executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = child;
    child.stdout.on("data", (data) => this.log("info", "Sendspin", { message: data.toString().trim() }));
    child.stderr.on("data", (data) => this.log("warn", "Sendspin", { message: data.toString().trim() }));
    child.on("error", (error) => {
      if (this.process === child) this.process = null;
      this.lastError = error.code === "ENOENT" ? `No se encontró el ejecutable “${this.executable}”. Instala Sendspin en el satélite.` : error.message;
      this.log("warn", "No se pudo iniciar el reproductor Music Assistant; instala sendspin", { executable: this.executable, error: error.message });
    });
    child.on("exit", (code, signal) => {
      if (this.process === child) this.process = null;
      if (!this.stoppedProcesses.has(child)) {
        this.lastError = `Sendspin terminó${code === null ? "" : ` con código ${code}`}${signal ? ` (${signal})` : ""}`;
        this.log("warn", "El reproductor Music Assistant terminó", { code, signal });
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.process === child ? resolve() : reject(new Error(this.lastError || "Sendspin no permaneció activo")), 350);
      child.once("error", (error) => { clearTimeout(timer); reject(new Error(error.code === "ENOENT" ? `No se encontró el ejecutable “${this.executable}”. Instala Sendspin en el satélite.` : error.message)); });
      child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Sendspin terminó${code === null ? "" : ` con código ${code}`}${signal ? ` (${signal})` : ""}`)); });
    }).catch((error) => {
      this.lastError = error.message;
      throw error;
    });
    this.log("info", "Reproductor Music Assistant iniciado", { name, clientId: `ha-${this.satelliteId}`, outputDevice: device || "predeterminado", discovery: this.serverUrl || "mDNS" });
    return this.status(config);
  }

  stop() {
    this.stopping = true;
    if (this.process) this.stoppedProcesses.add(this.process);
    this.process?.kill("SIGTERM");
    this.process = null;
  }

  status(config = {}) {
    return { enabled: config.musicPlayerEnabled !== false, running: Boolean(this.process), clientId: `ha-${this.satelliteId}`, outputDeviceId: config.musicOutputDeviceId || null, protocol: "sendspin", error: this.lastError };
  }
}
