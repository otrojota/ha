export function createBrowserSatelliteId(cryptoProvider = globalThis.crypto) {
  if (typeof cryptoProvider?.randomUUID === "function") return cryptoProvider.randomUUID();
  if (typeof cryptoProvider?.getRandomValues !== "function") {
    throw new Error("El navegador no ofrece generación de identidad segura");
  }
  const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
