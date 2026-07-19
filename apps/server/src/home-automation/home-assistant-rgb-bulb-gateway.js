import { DeviceGateway } from "./device-gateway.js";

export const RGB_BULB_TYPE = "rgb_bulb";
export const HOME_ASSISTANT_PROVIDER = "home_assistant";

export class HomeAssistantRgbBulbGateway extends DeviceGateway {
  constructor({ client = null, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
    super({ type: RGB_BULB_TYPE, provider: HOME_ASSISTANT_PROVIDER });
    this.client = client;
    this.wait = wait;
  }
  setClient(client) { this.client = client; }
  api() { if (!this.client) throw new Error("Configura primero la conexión con Home Assistant"); return this.client; }

  normalizeConfiguration(value = {}) {
    const entityId = String(value.entityId || "").trim().toLowerCase();
    if (!/^light\.[a-z0-9_]+$/.test(entityId)) throw new Error("Selecciona una entidad light.* válida de Home Assistant");
    return { entityId };
  }
  publicConfiguration(value) { return { entityId: value.entityId }; }

  async getState(device) {
    const state = await this.api().state(device.configuration.entityId);
    const attributes = state.attributes || {};
    return {
      on: state.state === "on",
      available: state.state !== "unavailable",
      brightnessPercent: Number.isFinite(attributes.brightness) ? Math.round(attributes.brightness * 100 / 255) : null,
      color: Array.isArray(attributes.hs_color) ? { hue: attributes.hs_color[0], saturationPercent: attributes.hs_color[1] } : null,
      colorTemperatureKelvin: attributes.color_temp_kelvin || null
    };
  }

  setPower(device, on) { return this.api().callService("light", on ? "turn_on" : "turn_off", { entity_id: device.configuration.entityId }); }
  async setBrightness(device, percent) {
    const requested = Math.round(percent);
    const previous = await this.getState(device);
    await this.api().callService("light", "turn_on", { entity_id: device.configuration.entityId, brightness_pct: requested, transition: 0 });
    let observed = null;
    let matchingReads = 0;
    for (const waitMs of [150, 350, 750, 1500]) {
      await this.wait(waitMs);
      observed = await this.getState(device);
      if (observed.available && observed.on && Number.isFinite(observed.brightnessPercent)
        && Math.abs(observed.brightnessPercent - requested) <= 2) {
        matchingReads += 1;
        if (matchingReads >= 2) return { ...observed, previousBrightnessPercent: previous.brightnessPercent, requestedBrightnessPercent: requested, verified: true };
      } else matchingReads = 0;
    }
    const detail = Number.isFinite(observed?.brightnessPercent)
      ? `quedó en ${observed.brightnessPercent}%`
      : "no informó un nivel de brillo";
    throw new Error(`Home Assistant aceptó el comando para ${device.name || device.configuration.entityId}, pero la luz ${detail}`);
  }
  async setColorTemperature(device, percent) {
    const state = await this.api().state(device.configuration.entityId);
    const minimum = Number(state.attributes?.min_color_temp_kelvin) || 2200;
    const maximum = Number(state.attributes?.max_color_temp_kelvin) || 6500;
    const kelvin = Math.round(minimum + (maximum - minimum) * percent / 100);
    return this.api().callService("light", "turn_on", { entity_id: device.configuration.entityId, color_temp_kelvin: kelvin });
  }
  setColor(device, { hue, saturationPercent, brightnessPercent }) {
    return this.api().callService("light", "turn_on", { entity_id: device.configuration.entityId, hs_color: [Math.round(hue), Math.round(saturationPercent)], brightness_pct: Math.round(brightnessPercent) });
  }
}
