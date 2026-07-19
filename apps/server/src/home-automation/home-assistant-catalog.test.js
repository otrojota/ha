import assert from "node:assert/strict";
import test from "node:test";
import { HomeAssistantCatalog } from "./home-assistant-catalog.js";

test("construye el catálogo usando nombres, plantas y habitaciones de Home Assistant", async () => {
  const registries = {
    "config/floor_registry/list": [{ floor_id: "abajo", name: "Primer piso" }],
    "config/area_registry/list": [{ area_id: "living", name: "Living", floor_id: "abajo" }],
    "config/device_registry/list": [{ id: "device-1", name: "Lámpara física", area_id: "living" }],
    "config/entity_registry/list": [{ entity_id: "light.lampara", device_id: "device-1", name: "Lámpara sofá", disabled_by: null }]
  };
  const client = {
    states: async () => [
      { entity_id: "light.lampara", state: "on", attributes: { friendly_name: "Nombre antiguo" } },
      { entity_id: "automation.noche", state: "on", attributes: { friendly_name: "Automatización" } }
    ],
    websocketCommand: async (type) => registries[type]
  };
  const state = await new HomeAssistantCatalog({ clientProvider: () => client }).refresh();
  assert.equal(state.devices.length, 1);
  assert.equal(state.devices[0].name, "Lámpara sofá");
  assert.equal(state.devices[0].room, "Living");
  assert.equal(state.devices[0].floor, "Primer piso");
  assert.equal(state.devices[0].domain, "light");
  assert.equal(state.devices[0].provider, "home_assistant");
  assert.equal(state.stale, false);
});

test("conserva el último catálogo si Home Assistant queda temporalmente inaccesible", async () => {
  let available = true;
  const client = {
    states: async () => {
      if (!available) throw new Error("sin conexión");
      return [{ entity_id: "sensor.temperatura", state: "21", attributes: { friendly_name: "Temperatura", unit_of_measurement: "°C" } }];
    },
    websocketCommand: async () => []
  };
  const catalog = new HomeAssistantCatalog({ clientProvider: () => client });
  await catalog.refresh();
  available = false;
  const state = await catalog.refresh();
  assert.equal(state.devices[0].unit, "°C");
  assert.equal(state.stale, true);
  assert.equal(state.error, "sin conexión");
});

test("excluye las entidades internas de Backup y Sun", async () => {
  const registryEntities = [
    { entity_id: "sensor.backup_state", platform: "backup" },
    { entity_id: "sensor.proximo_amanecer", platform: "sun" },
    { entity_id: "sensor.temperatura", platform: "mqtt" }
  ];
  const client = {
    states: async () => registryEntities.map(({ entity_id }) => ({ entity_id, state: "ok", attributes: {} })),
    websocketCommand: async (type) => type === "config/entity_registry/list" ? registryEntities : []
  };
  const state = await new HomeAssistantCatalog({ clientProvider: () => client }).refresh();
  assert.deepEqual(state.devices.map((device) => device.entityId), ["sensor.temperatura"]);
});
