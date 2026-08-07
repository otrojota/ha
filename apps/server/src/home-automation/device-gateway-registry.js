export class DeviceGatewayRegistry {
  constructor(gateways = []) {
    this.gateways = new Map(gateways.map((gateway) => [this.key(gateway.type, gateway.provider), gateway]));
  }

  key(type, provider) { return `${type}:${provider}`; }
  has(type, provider) { return this.gateways.has(this.key(type, provider)); }

  get(type, provider) {
    const gateway = this.gateways.get(this.key(type, provider));
    if (!gateway) throw new Error(`No existe gateway para ${type}/${provider}`);
    return gateway;
  }

  catalog() {
    return [...this.gateways.values()].map(({ type, provider }) => ({
      type, provider,
      name: type === "rgb_bulb" ? "Ampolleta RGB" : type,
      providerName: provider === "home_assistant" ? "Home Assistant" : provider === "tuya" ? "Tuya" : provider,
      capabilities: type === "rgb_bulb" ? ["power", "brightness", "color", "color_temperature"] : []
    }));
  }
}
