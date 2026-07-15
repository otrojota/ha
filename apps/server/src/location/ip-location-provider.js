import { validateLocation } from "../config/server-config.js";

export class IpLocationProvider {
  constructor({ url = "https://ipwho.is/", timeoutMs = 8000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async detect() {
    const response = await fetch(this.url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`El servicio de ubicación respondió HTTP ${response.status}`);
    const value = await response.json();
    if (value.success === false) throw new Error(value.message || "No fue posible detectar la ubicación");
    return validateLocation({
      city: value.city,
      region: value.region,
      country: value.country,
      countryCode: value.country_code,
      latitude: value.latitude,
      longitude: value.longitude,
      timeZone: value.timezone?.id,
      source: "ip",
      ip: value.ip
    });
  }
}
