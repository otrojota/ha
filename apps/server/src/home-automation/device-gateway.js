export class DeviceGateway {
  constructor({ type, provider }) {
    if (!type || !provider) throw new Error("Todo gateway necesita tipo y proveedor");
    this.type = type;
    this.provider = provider;
  }

  normalizeConfiguration() {
    throw new Error("El gateway debe implementar normalizeConfiguration");
  }

  publicConfiguration(configuration) {
    return configuration;
  }
}
