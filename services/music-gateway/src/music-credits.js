import { readFile } from "node:fs/promises";

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function emptyCredits(item) {
  return {
    title: item?.name || null,
    album: item?.album || null,
    isrc: item?.isrc || null,
    creditedArtists: item?.artists || [],
    vocalists: [],
    performers: [],
    composers: [],
    lyricists: [],
    producers: [],
    engineers: [],
    sources: item ? ["spotify"] : [],
    detailedCreditsAvailable: false
  };
}

function mergeCredits(base, extra, source) {
  const result = { ...base };
  for (const field of ["vocalists", "composers", "lyricists", "producers", "engineers"]) {
    result[field] = unique([...(base[field] || []), ...(extra[field] || [])]);
  }
  const performers = [...(base.performers || []), ...(extra.performers || [])];
  result.performers = [...new Map(performers.map((entry) => [`${normalized(entry.name)}:${normalized(entry.role)}`, entry])).values()];
  result.sources = unique([...(base.sources || []), source]);
  result.detailedCreditsAvailable = ["vocalists", "performers", "composers", "lyricists", "producers", "engineers"]
    .some((field) => result[field].length > 0);
  return result;
}

function creditsFromRelations(value) {
  const credits = { vocalists: [], performers: [], composers: [], lyricists: [], producers: [], engineers: [] };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.type && node.artist?.name) {
      const type = normalized(node.type);
      const name = node.artist.name;
      const attributes = (node.attributes || []).join(", ");
      if (/vocal|lead vocals|background vocals/.test(type) || /vocal/i.test(attributes)) credits.vocalists.push(name);
      if (/composer|writer/.test(type)) credits.composers.push(name);
      if (/lyricist/.test(type)) credits.lyricists.push(name);
      if (/producer/.test(type)) credits.producers.push(name);
      if (/engineer|mix|mastering/.test(type)) credits.engineers.push(name);
      if (/performer|instrument|vocal/.test(type) || attributes) credits.performers.push({ name, role: attributes || node.type });
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return credits;
}

export class MusicCreditsService {
  constructor({ localPath, fetchImpl = fetch, userAgent = "HA-Voice-Assistant/0.1", log = () => {} }) {
    this.localPath = localPath;
    this.fetch = fetchImpl;
    this.userAgent = userAgent;
    this.log = log;
    this.cache = new Map();
  }

  async localCredits(item) {
    if (!this.localPath) return null;
    try {
      const saved = JSON.parse(await readFile(this.localPath, "utf8"));
      const entries = Array.isArray(saved) ? saved : saved.credits || [];
      return entries.find((entry) =>
        (item.isrc && normalized(entry.isrc) === normalized(item.isrc))
        || (normalized(entry.title) === normalized(item.name) && (!entry.creditedArtist || item.artists.some((artist) => normalized(artist) === normalized(entry.creditedArtist))))
      ) || null;
    } catch (error) {
      if (error.code !== "ENOENT") this.log("warn", "No se pudieron leer créditos locales", { error: error.message });
      return null;
    }
  }

  async musicBrainzCredits(item) {
    if (!item.isrc) return null;
    if (this.cache.has(item.isrc)) return this.cache.get(item.isrc);
    const url = `https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(item.isrc)}?inc=artist-rels+work-rels+recording-rels&fmt=json`;
    try {
      const response = await this.fetch(url, { headers: { Accept: "application/json", "User-Agent": this.userAgent }, signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = creditsFromRelations(await response.json());
      this.cache.set(item.isrc, result);
      return result;
    } catch (error) {
      this.log("warn", "MusicBrainz no pudo enriquecer los créditos", { isrc: item.isrc, error: error.message });
      return null;
    }
  }

  async getCurrentCredits(playback) {
    const item = playback?.item;
    if (!item) return { ...emptyCredits(null), status: playback?.status || "idle", message: "No hay una canción activa" };
    let credits = emptyCredits(item);
    const local = await this.localCredits(item);
    if (local) credits = mergeCredits(credits, local, "local");
    const musicBrainz = await this.musicBrainzCredits(item);
    if (musicBrainz) credits = mergeCredits(credits, musicBrainz, "musicbrainz");
    return {
      ...credits,
      status: playback.status,
      device: playback.device?.name || null,
      limitation: credits.detailedCreditsAvailable ? null : "Spotify sólo identifica al artista acreditado; no se encontraron créditos detallados de intérpretes para esta grabación."
    };
  }
}
