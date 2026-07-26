import assert from "node:assert/strict";
import test from "node:test";
import { createHomeAssistantDeviceTools } from "./home-assistant-device-tools.js";

test("las tools por capacidad llaman el servicio correcto y refrescan el catálogo", async () => {
  const calls = [];
  const resolveCalls = [];
  let refreshes = 0;
  const devices = [{ name: "Ventilador living", entityId: "fan.living", domain: "fan" }];
  const tools = createHomeAssistantDeviceTools({
    home: { resolve: (target, room, options) => { resolveCalls.push([target, room, options]); return devices; }, getCatalogState: () => devices },
    clientProvider: () => ({ callService: async (...args) => calls.push(args) }),
    refresh: async () => { refreshes += 1; }
  });
  const power = tools.find((tool) => tool.definition.function.name === "home_set_power");
  const result = await power.execute({ target: "living", on: true });
  assert.deepEqual(calls, [["fan", "turn_on", { entity_id: "fan.living" }]]);
  assert.deepEqual(resolveCalls, [["living", undefined, { domains: ["switch", "fan"] }]]);
  assert.equal(result.count, 1);
  assert.equal(refreshes, 1);
});
