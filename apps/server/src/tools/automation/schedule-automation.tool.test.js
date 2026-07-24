import assert from "node:assert/strict";
import test from "node:test";
import { createScheduleAutomationTool } from "./schedule-automation.tool.js";

test("programa juntas acciones futuras de luces y música", async () => {
  let scheduled;
  const scheduler = { async schedule(value) { scheduled = value; return { id: "automation-1", ...value, scheduledFor: value.triggerAt.toISOString() }; } };
  const tool = createScheduleAutomationTool({ scheduler, homeEnabled: true });
  const result = await tool.execute({ triggerAt: "2026-07-16T15:00:00-04:00", actions: [
    { type: "light_turn_on", target: "Luz 1" },
    { type: "music_play", query: "Pink Floyd", mode: "artist" }
  ] }, { satelliteId: "sat-1", timeZone: "America/Santiago" });
  assert.equal(scheduled.kind, "automation");
  assert.equal(scheduled.actions.length, 2);
  assert.equal(result.actionCount, 2);
});

test("no expone acciones de luces cuando Home Assistant no está instalado", () => {
  const tool = createScheduleAutomationTool({ scheduler: {}, homeEnabled: false });
  const types = tool.definition.function.parameters.properties.actions.items.properties.type.enum;
  assert.equal(types.includes("light_turn_on"), false);
  assert.equal(types.includes("music_play"), true);
});

test("programa una acción diaria usando la zona horaria del servidor", async () => {
  let scheduled;
  const scheduler = { async schedule(value) { scheduled = value; return { id: "daily-1", ...value, scheduledFor: value.triggerAt.toISOString() }; } };
  const tool = createScheduleAutomationTool({ scheduler, homeEnabled: true });
  const result = await tool.execute({
    recurrence: { frequency: "daily", localTime: "20:00" },
    actions: [{ type: "light_turn_on", target: "Luz 1" }]
  }, { satelliteId: "sat-1", timeZone: "America/Santiago", now: () => new Date("2026-07-14T16:00:00Z") });
  assert.equal(result.scheduledFor, "2026-07-15T00:00:00.000Z");
  assert.deepEqual(scheduled.recurrence, { frequency: "daily", localTime: "20:00", timeZone: "America/Santiago" });
});

test("permite programar las mismas acciones de música y dispositivos Home Assistant", async () => {
  let scheduled;
  const scheduler = { async schedule(value) { scheduled = value; return { id: "tools-1", ...value, scheduledFor: value.triggerAt.toISOString() }; } };
  const tool = createScheduleAutomationTool({ scheduler, homeEnabled: true });

  await tool.execute({ delaySeconds: 60, announce: true, actions: [
    { type: "music_next", destination: "Pantallita" },
    { type: "home_set_power", target: "Ventilador", room: "Living", on: false },
    { type: "climate_set_temperature", target: "Termostato", temperature: 21 }
  ] }, { satelliteId: "sat-1", timeZone: "America/Santiago", now: () => new Date("2026-07-19T12:00:00Z") });

  assert.deepEqual(scheduled.actions, [
    { type: "music_next", destination: "Pantallita" },
    { type: "home_set_power", target: "Ventilador", room: "Living", on: false },
    { type: "climate_set_temperature", target: "Termostato", temperature: 21 }
  ]);
  assert.equal(scheduled.announce, true);
});
