import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

function isPrivateAddress(address) {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff");
  }
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

async function assertPublicUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("La URL no usa HTTP o HTTPS");
  if (url.username || url.password) throw new Error("No se permiten credenciales en la URL");
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("La URL apunta a una red no pública");
  return url;
}

function normalizeText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncateAtWord(text, maximum) {
  if (text.length <= maximum) return { text, truncated: false };
  const piece = text.slice(0, maximum + 1);
  const boundary = Math.max(piece.lastIndexOf(" "), piece.lastIndexOf("\n"));
  return { text: `${piece.slice(0, boundary > maximum * 0.75 ? boundary : maximum).trimEnd()}…`, truncated: true };
}

export class ReadableWebContentExtractor {
  constructor({ timeoutMs = 12_000, maxBytes = 1_500_000, maxRedirects = 3, maxCharacters = 6000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.maxRedirects = maxRedirects;
    this.maxCharacters = maxCharacters;
  }

  async extract(value) {
    let url = await assertPublicUrl(value);
    for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
      const response = await fetch(url, {
        redirect: "manual",
        headers: { Accept: "text/html,text/plain;q=0.9", "User-Agent": "Mozilla/5.0 (compatible; HA-Voice-Assistant/0.1; +local)" },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        if (redirect === this.maxRedirects) throw new Error("La página excedió el máximo de redirecciones");
        url = await assertPublicUrl(new URL(response.headers.get("location"), url).toString());
        continue;
      }
      if (!response.ok) throw new Error(`La página respondió HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) throw new Error(`Tipo de contenido no soportado: ${contentType || "desconocido"}`);
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > this.maxBytes) throw new Error("La página supera el tamaño máximo");
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > this.maxBytes) throw new Error("La página supera el tamaño máximo");
        chunks.push(chunk);
      }
      const source = Buffer.concat(chunks).toString("utf8");
      let title = "";
      let content = source;
      if (contentType.includes("text/html")) {
        const { document } = parseHTML(source);
        const article = new Readability(document).parse();
        title = article?.title || document.title || "";
        content = article?.textContent || document.body?.textContent || "";
      }
      const normalized = normalizeText(content);
      if (normalized.length < 40) throw new Error("La página no contiene suficiente texto legible");
      return { finalUrl: url.toString(), title: normalizeText(title), originalCharacters: normalized.length, ...truncateAtWord(normalized, this.maxCharacters) };
    }
    throw new Error("No fue posible descargar la página");
  }
}

export { assertPublicUrl, isPrivateAddress };
