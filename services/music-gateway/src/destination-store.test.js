import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { DestinationStore } from "./destination-store.js";

const players = [
  { id: "sendspin:kitchen", name: "Satellite Kitchen", available: true, enabled: true },
  { id: "sonos:living", name: "Sonos", available: true, enabled: true }
];

test("resuelve destinos exclusivamente por el nombre entregado por Music Assistant", async () => {
  const store = new DestinationStore("/tmp/unused-music-store.json");
  assert.equal(store.resolve(players, "Satellite Kitchen", "satellite-test").id, "sendspin:kitchen");
  assert.equal(store.resolve(players, "Sonos", "satellite-test").id, "sonos:living");
  assert.throws(() => store.resolve(players, "cocina", "satellite-test"), /No existe un destino/);
});

test("resuelve directamente el identificador opaco enviado por el display", () => {
  const opaqueId = "up1769bcb7e82a11f0a7c6800a805c1d06";
  const store = new DestinationStore("/tmp/unused-music-store.json");
  const result = store.resolve([{ id: opaqueId, name: "DMP-A6", available: true, enabled: true }], opaqueId, "satellite-test");
  assert.equal(result.id, opaqueId);
});

test("resuelve destinos con números hablados y transcripciones fonéticas", () => {
  const store = new DestinationStore("/tmp/unused-music-store.json");
  const eversolos = [
    { id: "eversolo-1", name: "Eversolo 1", available: true, enabled: true },
    { id: "eversolo-2", name: "Eversolo 2", available: true, enabled: true }
  ];
  assert.equal(store.resolve(eversolos, "e ver solo uno", "satellite-test").id, "eversolo-1");
  assert.equal(store.resolve(eversolos, "haber solo dos", "satellite-test").id, "eversolo-2");
  assert.throws(() => store.resolve(eversolos, "haber solo", "satellite-test"), /ambiguo/);
});

test("decora la lista de MA sin inventar destinos locales", () => {
  const store = new DestinationStore("/tmp/unused-music-store.json");
  store.state.activeDestinationIds["satellite-test"] = "sonos:living";
  const result = store.decorate(players, "satellite-test");
  assert.equal(result.length, 2);
  assert.equal(result[1].active, true);
  assert.equal(result[0].alias, undefined);
  assert.equal(result[0].room, undefined);
});

test("mantiene un destino activo independiente para cada satélite", async () => {
  const store = new DestinationStore("/tmp/unused-music-store.json");
  store.save = async () => {};

  await store.setActive(players, "Satellite Kitchen", "satellite-rpi");
  await store.setActive(players, "Sonos", "satellite-mac");

  assert.equal(store.resolve(players, undefined, "satellite-rpi").id, "sendspin:kitchen");
  assert.equal(store.resolve(players, undefined, "satellite-mac").id, "sonos:living");
  assert.equal(store.decorate(players, "satellite-rpi")[0].active, true);
  assert.equal(store.decorate(players, "satellite-mac")[1].active, true);
});

test("conserva y resuelve el origen activo por nombre", async () => {
  const store = new DestinationStore("/tmp/unused-music-store.json");
  store.save = async () => {};
  const sources = [
    { id: "tidal--abc", domain: "tidal", name: "Tidal", available: true, streaming: true },
    { id: "filesystem--local", domain: "filesystem_local", name: "Archivos locales", available: true, streaming: false }
  ];
  assert.equal(store.resolveSource(sources, undefined, "satellite-test").id, "tidal--abc");
  assert.equal((await store.setActiveSource(sources, "archivos locales", "satellite-test")).id, "filesystem--local");
  assert.equal(store.resolveSource(sources, undefined, "satellite-test").id, "filesystem--local");
});

test("mantiene un origen activo independiente para cada satélite", async () => {
  const store = new DestinationStore("/tmp/unused-music-store.json");
  store.save = async () => {};
  const sources = [
    { id: "spotify--home", domain: "spotify", name: "Spotify", available: true },
    { id: "radiobrowser--world", domain: "radiobrowser", name: "RadioBrowser", available: true }
  ];

  await store.setActiveSource(sources, "RadioBrowser", "satellite-rpi");
  await store.setActiveSource(sources, "Spotify", "satellite-mac");

  assert.equal(store.resolveSource(sources, undefined, "satellite-rpi").id, "radiobrowser--world");
  assert.equal(store.resolveSource(sources, undefined, "satellite-mac").id, "spotify--home");
});

test("resuelve orígenes por transcripciones normalizadas y difusas", () => {
  const store = new DestinationStore("/tmp/unused-music-store.json");
  const sources = [
    { id: "spotify--home", domain: "spotify", name: "Spotify", available: true },
    { id: "tidal--home", domain: "tidal", name: "Tidal", available: true }
  ];
  assert.equal(store.resolveSource(sources, "spot if i", "satellite-test").id, "spotify--home");
  assert.equal(store.resolveSource(sources, "tid all", "satellite-test").id, "tidal--home");
});

test("rechaza el estado global de versiones anteriores", async () => {
  const path = `/tmp/ha-music-store-${process.pid}-${Date.now()}.json`;
  await mkdir("/tmp", { recursive: true });
  await writeFile(path, JSON.stringify({ activeDestinationId: "old", activeDestinationIds: {}, activeSourceIds: {} }));
  await assert.rejects(() => new DestinationStore(path).load(), /contrato actual/);
});
