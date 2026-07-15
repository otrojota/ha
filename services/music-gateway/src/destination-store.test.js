import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DestinationStore, publicIntegrationConfig } from "./destination-store.js";

const discovered = {
  id: "spotify:eversolo",
  providerDeviceId: "eversolo",
  name: "Eversolo DMP-A6",
  source: "spotify-connect",
  available: true,
  routes: [{ id: "spotify:eversolo:connect", label: "Spotify Connect", available: true }]
};

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "ha-music-store-"));
  const store = new DestinationStore(join(directory, "music.json"));
  await store.load();
  return store;
}

test("agrega un dispositivo Spotify y preserva sus ajustes", async () => {
  const store = await createStore();
  await store.addDestination(discovered);
  await store.updateDestination(discovered.id, { alias: "Equipo principal", room: "Living" });
  await store.addDestination({ ...discovered, name: "Eversolo" });
  assert.deepEqual(store.listDestinations().map(({ name, alias, room }) => ({ name, alias, room })), [
    { name: "Eversolo", alias: "Equipo principal", room: "Living" }
  ]);
});

test("actualiza disponibilidad sin borrar un destino agregado", async () => {
  const store = await createStore();
  await store.addDestination(discovered);
  await store.updateSpotifyAvailability([]);
  assert.equal(store.listDestinations()[0].available, false);
});

test("no expone tokens OAuth de Spotify", async () => {
  const store = await createStore();
  await store.updateSpotifyIntegration({ clientId: "client", accessToken: "access-secret", refreshToken: "refresh-secret" });
  assert.deepEqual(publicIntegrationConfig(store.getSpotifyIntegration()), {
    clientId: "client",
    redirectUri: "http://127.0.0.1:3100/v1/integrations/spotify/callback",
    connected: true
  });
  assert.match(await readFile(store.path, "utf8"), /refresh-secret/);
  assert.doesNotMatch(JSON.stringify(publicIntegrationConfig(store.getSpotifyIntegration())), /secret/);
});

test("persiste el destino activo y permite resolverlo por alias", async () => {
  const store = await createStore();
  await store.addDestination(discovered);
  await store.updateDestination(discovered.id, { alias: "Eversolo", room: "Living" });
  const second = {
    ...discovered,
    id: "spotify:macbook",
    providerDeviceId: "macbook",
    name: "MacBook Pro",
    routes: [{ id: "spotify:macbook:connect", label: "Spotify Connect", available: true }]
  };
  await store.addDestination(second);
  const active = await store.setActiveDestination("MacBook Pro");
  assert.equal(active.id, second.id);

  const restored = new DestinationStore(store.path);
  await restored.load();
  assert.equal(restored.getActiveDestination().id, second.id);
  assert.equal(restored.resolveDestination("Eversolo").id, discovered.id);
  assert.equal(restored.resolveDestination("DMP A6").id, discovered.id);
  assert.equal(restored.resolveDestination("DMPA6").id, discovered.id);
  await assert.rejects(() => restored.setActiveDestination("Dormitorio"), /No existe un destino agregado/);
});
