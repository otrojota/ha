import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/\b(uno|una)\b/g, "1").replace(/\b(dos)\b/g, "2").replace(/\b(tres)\b/g, "3")
    .replace(/\b(cuatro)\b/g, "4").replace(/\b(cinco)\b/g, "5").replace(/\b(seis)\b/g, "6")
    .replace(/\b(siete)\b/g, "7").replace(/\b(ocho)\b/g, "8").replace(/\b(nueve)\b/g, "9");
}

function compact(value) { return normalized(value).replace(/\s/g, ""); }

function phonetic(value) {
  return compact(value)
    .replace(/^h/, "").replace(/h/g, "")
    .replace(/[bv]/g, "v").replace(/ll|y/g, "y")
    .replace(/[sz]/g, "s").replace(/ce|ci/g, "se").replace(/c/g, "k")
    .replace(/qu/g, "k").replace(/ge|gi|j/g, "j").replace(/gue/g, "ge").replace(/gui/g, "gi");
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function similarity(left, right) {
  if (!left || !right) return 0;
  return 1 - editDistance(left, right) / Math.max(left.length, right.length);
}

function fuzzyMatches(items, query, labelsFor) {
  const wanted = compact(query);
  const wantedPhonetic = phonetic(query);
  return items.map((item) => ({
    item,
    score: Math.max(...labelsFor(item).filter(Boolean).map((label) => Math.max(
      similarity(wanted, compact(label)),
      similarity(wantedPhonetic, phonetic(label))
    )), 0)
  })).sort((left, right) => right.score - left.score);
}

function resolveByLabels(items, query, labelsFor, kind) {
  const wanted = compact(query);
  const direct = items.filter((item) => labelsFor(item).filter(Boolean).some((label) => {
    const value = compact(label);
    return value === wanted || value.includes(wanted) || wanted.includes(value);
  }));
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) throw new Error(`El ${kind} “${query}” es ambiguo: ${direct.map((item) => labelsFor(item).find(Boolean)).join(", ")}`);
  const ranked = fuzzyMatches(items, query, labelsFor);
  if (!ranked.length || ranked[0].score < 0.68) return null;
  if (ranked[1] && ranked[0].score - ranked[1].score < 0.08) {
    throw new Error(`El ${kind} “${query}” es ambiguo: ${ranked.slice(0, 3).map(({ item }) => labelsFor(item).find(Boolean)).join(", ")}`);
  }
  return ranked[0].item;
}

export class DestinationStore {
  constructor(path) { this.path = path; this.state = { activeDestinationIds: {}, activeSourceIds: {} }; }
  async load() {
    try {
      const saved = JSON.parse(await readFile(this.path, "utf8"));
      const keys = Object.keys(saved).sort();
      if (keys.join(",") !== "activeDestinationIds,activeSourceIds" || !saved.activeDestinationIds || !saved.activeSourceIds
        || Array.isArray(saved.activeDestinationIds) || Array.isArray(saved.activeSourceIds)) {
        throw new Error("La configuración de música no cumple el contrato actual");
      }
      this.state = { activeDestinationIds: saved.activeDestinationIds, activeSourceIds: saved.activeSourceIds };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`);
    await rename(temporary, this.path);
  }
  activeDestinationId(scope) {
    if (!String(scope || "").trim()) throw new Error("Falta satelliteId para resolver el destino activo");
    return this.state.activeDestinationIds[String(scope).trim()] || null;
  }
  decorate(players, scope) {
    const activeDestinationId = this.activeDestinationId(scope);
    return players.map((player) => ({ ...player, active: player.id === activeDestinationId }));
  }
  resolve(players, query, scope) {
    const decorated = this.decorate(players, scope);
    if (!query) return decorated.find((player) => player.active) || null;
    const exactId = decorated.find((player) => String(player.id) === String(query));
    if (exactId) return exactId;
    const match = resolveByLabels(decorated, query, (player) => [player.name], "destino");
    if (!match) throw new Error(`No existe un destino de Music Assistant que coincida con “${query}”`);
    return match;
  }
  async setActive(players, query, scope) {
    const player = this.resolve(players, query, scope);
    if (!player) throw new Error("Music Assistant no tiene destinos disponibles");
    if (!player.available) throw new Error(`El destino ${player.name} no está disponible`);
    const key = String(scope || "").trim();
    if (!key) throw new Error("Falta satelliteId para seleccionar el destino activo");
    this.state.activeDestinationIds[key] = player.id;
    await this.save();
    return { ...player, active: true };
  }
  activeSourceId(scope) {
    if (!String(scope || "").trim()) throw new Error("Falta satelliteId para resolver el origen activo");
    return this.state.activeSourceIds[String(scope).trim()] || null;
  }
  resolveSource(sources, query, scope) {
    const available = sources.filter((source) => source.available !== false);
    if (!query) return available.find((source) => source.id === this.activeSourceId(scope)) || available.find((source) => source.streaming) || available[0] || null;
    const exact = available.find((source) => String(source.id) === String(query));
    if (exact) return exact;
    const match = resolveByLabels(available, query, (source) => [source.name, source.domain], "origen");
    if (!match) throw new Error(`No existe un origen disponible en Music Assistant que coincida con “${query}”`);
    return match;
  }
  async setActiveSource(sources, query, scope) {
    const source = this.resolveSource(sources, query, scope);
    if (!source) throw new Error("Music Assistant no tiene orígenes disponibles");
    const key = String(scope || "").trim();
    if (!key) throw new Error("Falta satelliteId para seleccionar el origen activo");
    this.state.activeSourceIds[key] = source.id;
    await this.save();
    return { ...source, active: true };
  }
}
