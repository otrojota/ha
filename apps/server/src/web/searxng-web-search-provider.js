import { WebSearchProvider } from "./web-search-provider.js";

export class SearxngWebSearchProvider extends WebSearchProvider {
  constructor({ baseUrl, timeoutMs = 10_000 }) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async search(query, { locale = "es-CL", limit = 5 } = {}) {
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", "general");
    url.searchParams.set("language", locale);
    url.searchParams.set("safesearch", "1");
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "HA-Voice-Assistant/0.1" },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`SearXNG respondió HTTP ${response.status}`);
    const body = await response.json();
    return (body.results || []).slice(0, limit).map((result) => ({
      title: String(result.title || "Sin título").trim(),
      url: String(result.url || "").trim(),
      snippet: String(result.content || "").trim(),
      engine: result.engine || null
    })).filter((result) => result.url);
  }
}
