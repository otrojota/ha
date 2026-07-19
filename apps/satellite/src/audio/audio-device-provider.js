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
  const technicalId = String(id);
  const label = String(name ?? "").trim();
  const invalidLabel = !label || /^(?:null|undefined|none|\(null\)|<null>)$/i.test(label);
  return { id: technicalId, name: invalidLabel ? technicalId : label, available: true, ...extra };
}
