import assert from "node:assert/strict";
import test from "node:test";
import { ScheduledAutomationExecutor } from "./scheduled-automation-executor.js";

test("ejecuta todas las acciones programadas aunque una falle", async () => {
  const calls = [];
  const executor = new ScheduledAutomationExecutor({
    home: { async setPower(target, on) { calls.push(["light", target, on]); throw new Error("sin conexión"); } },
    music: { async play(value) { calls.push(["music", value.query]); return { status: "playing" }; } }
  });
  const result = await executor.execute({ id: "a", actions: [
    { type: "light_turn_on", target: "Luz 1" }, { type: "music_play", query: "Pink Floyd", mode: "artist", shuffle: true }
  ] });
  assert.deepEqual(calls, [["light", "Luz 1", true], ["music", "Pink Floyd"]]);
  assert.equal(result.success, false);
  assert.deepEqual(result.results.map((item) => item.success), [false, true]);
});
