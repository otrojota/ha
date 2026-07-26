import assert from "node:assert/strict";
import test from "node:test";
import { HomeAutomationService } from "./home-automation-service.js";

test("controla todas las luces de una habitación mediante su gateway", async () => {
  const calls = [];
  const gateway = { setPower: async (device, on) => calls.push([device.name, on]) };
  const store = { snapshot: () => ({ rooms: [{ id: "room", name: "Living" }], devices: [
    { id: "1", name: "Luz uno", domain: "light", roomId: "room", type: "rgb_bulb", provider: "home_assistant", enabled: true },
    { id: "2", name: "Luz dos", domain: "light", roomId: "room", type: "rgb_bulb", provider: "home_assistant", enabled: true }
  ] }) };
  const service = new HomeAutomationService({ store, gateways: { has: () => true, get: () => gateway } });
  const result = await service.setPower("living", false);
  assert.deepEqual(calls, [["Luz uno", false], ["Luz dos", false]]);
  assert.equal(result.count, 2);
});

test("resuelve números hablados y usa la habitación como contexto separado", () => {
  const store = { snapshot: () => ({
    floors: [],
    rooms: [
      { id: "jota", name: "Escritorio Jota" },
      { id: "maria", name: "Escritorio María" }
    ],
    devices: [
      { id: "light.luz_1_jota", name: "Luz 1", roomId: "jota", room: "Escritorio Jota", type: "rgb_bulb", provider: "home_assistant", enabled: true },
      { id: "light.luz_1_maria", name: "Luz 1", roomId: "maria", room: "Escritorio María", type: "rgb_bulb", provider: "home_assistant", enabled: true }
    ]
  }) };
  const service = new HomeAutomationService({ store, gateways: { has: () => true, get: () => ({}) } });
  assert.equal(service.resolve("Luz uno", "Escritorio Jota")[0].id, "light.luz_1_jota");
  assert.throws(() => service.resolve("Luz uno"), /varios dispositivos/i);
});

test("resuelve Luz uno directamente cuando sólo existe Luz 1", () => {
  const store = { snapshot: () => ({ floors: [], rooms: [], devices: [
    { id: "light.luz_1", name: "Luz 1", roomId: null, type: "rgb_bulb", provider: "home_assistant", enabled: true }
  ] }) };
  const service = new HomeAutomationService({ store, gateways: { has: () => true, get: () => ({}) } });
  assert.equal(service.resolve("luz uno")[0].name, "Luz 1");
});

test("una operación de luz resuelve Simón sin confundir el enchufe Simón", async () => {
  const calls = [];
  const gateway = { setPower: async (device, on) => calls.push([device.name, on]) };
  const store = { snapshot: () => ({
    floors: [],
    rooms: [{ id: "memo", name: "Pieza Memo" }],
    devices: [
      { id: "light.simon", name: "Luz Simón", domain: "light", roomId: "memo", type: "rgb_bulb", provider: "home_assistant", enabled: true },
      { id: "switch.simon", name: "Enchufe Simón", domain: "switch", roomId: "memo", type: "switch", provider: "home_assistant", enabled: true },
      { id: "sensor.simon_power", name: "Enchufe Simón Power", domain: "sensor", roomId: "memo", type: "sensor", provider: "home_assistant", enabled: true }
    ]
  }) };
  const service = new HomeAutomationService({ store, gateways: { has: () => true, get: () => gateway } });

  const result = await service.setPower("Simón", false);

  assert.deepEqual(calls, [["Luz Simón", false]]);
  assert.deepEqual(result.affected, ["Luz Simón"]);
});
