import assert from "node:assert/strict";
import test from "node:test";
import { createEvent, EventType, isEvent, PROTOCOL_VERSION, requireSatelliteId } from "./index.js";

test("crea únicamente eventos del protocolo actual", () => {
  const event = createEvent(EventType.SATELLITE_CONNECTED, { ready: true }, "satellite-rpi");
  assert.equal(event.protocolVersion, PROTOCOL_VERSION);
  assert.equal(isEvent(event), true);
  assert.equal(isEvent({ ...event, protocolVersion: "1" }), false);
  assert.equal(isEvent({ ...event, type: "legacy.event" }), false);
});

test("satelliteId es obligatorio en operaciones con alcance", () => {
  assert.equal(requireSatelliteId(" satellite-rpi "), "satellite-rpi");
  assert.throws(() => requireSatelliteId(""), /Satellite-Id/);
});
