import test from "node:test";
import assert from "node:assert/strict";
import { DestinationStore } from "./destination-store.js";

const players = [
  { id: "sendspin:kitchen", name: "Satellite Kitchen", available: true, enabled: true },
  { id: "sonos:living", name: "Sonos", available: true, enabled: true }
];

test("resuelve destinos de Music Assistant por nombre y alias", async () => {
  const store = new DestinationStore("/tmp/unused-music-store.json");
  store.state.preferences["sendspin:kitchen"] = { alias: "Parlante cocina", room: "Cocina", enabled: true };
  assert.equal(store.resolve(players, "cocina").id, "sendspin:kitchen");
  assert.equal(store.resolve(players, "Sonos").id, "sonos:living");
});

test("resuelve directamente el identificador opaco enviado por el display", () => {
  const opaqueId = "up1769bcb7e82a11f0a7c6800a805c1d06";
  const store = new DestinationStore("/tmp/unused-music-store.json");
  const result = store.resolve([{ id: opaqueId, name: "DMP-A6", available: true, enabled: true }], opaqueId);
  assert.equal(result.id, opaqueId);
});

test("resuelve destinos con números hablados y transcripciones fonéticas", () => {
  const store = new DestinationStore("/tmp/unused-music-store.json");
  const eversolos = [
    { id: "eversolo-1", name: "Eversolo 1", available: true, enabled: true },
    { id: "eversolo-2", name: "Eversolo 2", available: true, enabled: true }
  ];
  assert.equal(store.resolve(eversolos, "e ver solo uno").id, "eversolo-1");
  assert.equal(store.resolve(eversolos, "haber solo dos").id, "eversolo-2");
  assert.throws(() => store.resolve(eversolos, "haber solo"), /ambiguo/);
});

test("decora la lista de MA sin inventar destinos locales", () => {
  const store = new DestinationStore("/tmp/unused-music-store.json");
  store.state.activeDestinationId = "sonos:living";
  const result = store.decorate(players);
  assert.equal(result.length, 2);
  assert.equal(result[1].active, true);
});

test("conserva y resuelve el origen activo por nombre", async () => {
  const store = new DestinationStore("/tmp/unused-music-store.json");
  store.save = async () => {};
  const sources = [
    { id: "tidal--abc", domain: "tidal", name: "Tidal", available: true, streaming: true },
    { id: "filesystem--local", domain: "filesystem_local", name: "Archivos locales", available: true, streaming: false }
  ];
  assert.equal(store.resolveSource(sources).id, "tidal--abc");
  assert.equal((await store.setActiveSource(sources, "archivos locales")).id, "filesystem--local");
  assert.equal(store.resolveSource(sources).id, "filesystem--local");
});

test("resuelve orígenes por transcripciones normalizadas y difusas", () => {
  const store = new DestinationStore("/tmp/unused-music-store.json");
  const sources = [
    { id: "spotify--home", domain: "spotify", name: "Spotify", available: true },
    { id: "tidal--home", domain: "tidal", name: "Tidal", available: true }
  ];
  assert.equal(store.resolveSource(sources, "spot if i").id, "spotify--home");
  assert.equal(store.resolveSource(sources, "tid all").id, "tidal--home");
});
