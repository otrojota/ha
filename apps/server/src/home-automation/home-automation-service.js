function normalized(value) {
  return String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/\b(?:numero|nro)\s+/g, "")
    .replace(/\b(?:uno|una)\b/g, "1").replace(/\bdos\b/g, "2").replace(/\btres\b/g, "3")
    .replace(/\bcuatro\b/g, "4").replace(/\bcinco\b/g, "5").replace(/\bseis\b/g, "6")
    .replace(/\bsiete\b/g, "7").replace(/\bocho\b/g, "8").replace(/\bnueve\b/g, "9").replace(/\bdiez\b/g, "10")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

export class HomeAutomationService {
  constructor({ store, gateways }) { this.store = store; this.gateways = gateways; }

  list() {
    const state = this.store.snapshot();
    return state.devices.filter((device) => device.enabled !== false).map((device) => ({
      id: device.id, name: device.name, room: state.rooms.find((room) => room.id === device.roomId)?.name || null,
      floor: state.floors?.find((floor) => floor.id === device.floorId)?.name || device.floor || null,
      domain: device.domain || null, type: device.type, provider: device.provider,
      available: device.available !== false, state: device.state, unit: device.unit || null,
      capabilities: device.capabilities || []
    }));
  }

  resolve(target, roomTarget) {
    const wanted = normalized(target);
    if (!wanted) throw new Error("Indica el nombre del dispositivo o habitación");
    const state = this.store.snapshot();
    let enabled = state.devices.filter((device) => device.enabled !== false);
    if (roomTarget) {
      const wantedRoom = normalized(roomTarget);
      const room = state.rooms.find((item) => normalized(item.name) === wantedRoom);
      if (!room) throw new Error(`Home Assistant no tiene una habitación llamada “${roomTarget}”`);
      enabled = enabled.filter((device) => device.roomId === room.id);
      if (!enabled.length) throw new Error(`La habitación ${room.name} no tiene dispositivos habilitados`);
    }
    const byDevice = enabled.filter((device) => normalized(device.name) === wanted || device.id === target);
    if (byDevice.length === 1) return byDevice;
    if (byDevice.length > 1) {
      const options = byDevice.map((device) => `${device.name}${device.room ? ` en ${device.room}` : ""}`).join(", ");
      throw new Error(`Hay varios dispositivos que coinciden con “${target}”: ${options}. Indica la habitación`);
    }
    const room = !roomTarget && state.rooms.find((item) => normalized(item.name) === wanted);
    if (room) {
      const devices = enabled.filter((device) => device.roomId === room.id);
      if (!devices.length) throw new Error(`La habitación ${room.name} no tiene dispositivos habilitados`);
      return devices;
    }
    const partial = enabled.filter((device) => normalized(device.name).includes(wanted) || wanted.includes(normalized(device.name)));
    if (partial.length === 1) return partial;
    if (partial.length > 1) {
      const options = partial.map((device) => `${device.name}${device.room ? ` en ${device.room}` : ""}`).join(", ");
      throw new Error(`Hay varias coincidencias para “${target}”: ${options}. Indica la habitación`);
    }
    throw new Error(`No existe un dispositivo o habitación que coincida con “${target}”`);
  }

  async run(target, operation, room) {
    const resolved = this.resolve(target, room);
    const devices = resolved.filter((device) => this.gateways.has(device.type, device.provider));
    if (!devices.length) throw new Error(`“${target}” no admite esta acción`);
    const results = await Promise.all(devices.map(async (device) => {
      const gateway = this.gateways.get(device.type, device.provider);
      return { device: device.name, result: await operation(gateway, device) };
    }));
    return { affected: results.map(({ device }) => device), count: results.length, results };
  }

  getState(target, room) { return this.run(target, (gateway, device) => gateway.getState(device), room); }
  getCatalogState(target, room) {
    const devices = this.resolve(target, room);
    return { count: devices.length, devices: devices.map(({ name, entityId, domain, floor, room, state, unit, available, capabilities }) => ({
      name, entityId, domain, floor: floor || null, room: room || null, state, unit: unit || null, available, capabilities
    })) };
  }
  setPower(target, on, room) { return this.run(target, (gateway, device) => gateway.setPower(device, on), room); }
  setBrightness(target, percent, room) { return this.run(target, (gateway, device) => gateway.setBrightness(device, percent), room); }
  setColorTemperature(target, percent, room) { return this.run(target, (gateway, device) => gateway.setColorTemperature(device, percent), room); }
  setColor(target, color, room) { return this.run(target, (gateway, device) => gateway.setColor(device, color), room); }
}
