export class AudioDeviceProvider {
  constructor(name) {
    this.name = name;
  }

  async listInputDevices() {
    throw new Error("listInputDevices no implementado");
  }

  async listOutputDevices() {
    throw new Error("listOutputDevices no implementado");
  }

  async listInputChannels() {
    return [{ id: 0, name: "Canal 1" }];
  }
}

export function normalizeDevice(id, name, extra = {}) {
  return { id: String(id), name: name || String(id), available: true, ...extra };
}
