import assert from "node:assert/strict";
import test from "node:test";
import { OutputVolumeDucker } from "./output-volume-ducker.js";

test("reduce y restaura el sink PipeWire seleccionado", async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, args]);
    if (args.includes("sinks")) return { stdout: JSON.stringify([
      { name: "speaker", state: "RUNNING", volume: { left: { value: 41943 }, right: { value: 41943, value_percent: "64%" } } }
    ]) };
    return { stdout: "" };
  };
  const ducker = new OutputVolumeDucker({ platform: "linux", readConfig: async () => ({ outputDeviceId: "speaker" }), exec });

  await ducker.duck();
  await ducker.duck();
  await ducker.restore();

  assert.deepEqual(calls.filter(([, args]) => args[0] === "set-sink-volume").map(([, args]) => args), [
    ["set-sink-volume", "speaker", "10%"],
    ["set-sink-volume", "speaker", "64%"]
  ]);
});

test("conserva el volumen guardado si la primera restauración falla", async () => {
  let restoreAttempts = 0;
  const exec = async (_command, args) => {
    if (args.includes("sinks")) return { stdout: JSON.stringify([
      { name: "speaker", state: "RUNNING", volume: { left: { value: 32768 } } }
    ]) };
    if (args[0] === "set-sink-volume" && args[2] === "50%" && restoreAttempts++ === 0) {
      throw new Error("PipeWire ocupado");
    }
    return { stdout: "" };
  };
  const ducker = new OutputVolumeDucker({ platform: "linux", readConfig: async () => ({ outputDeviceId: "speaker" }), exec });

  await ducker.duck();
  await assert.rejects(ducker.restore(), /PipeWire ocupado/);
  await ducker.restore();

  assert.equal(restoreAttempts, 2);
  assert.equal(ducker.saved, null);
});

test("restaura el volumen global anterior en macOS", async () => {
  const scripts = [];
  const exec = async (_command, args) => {
    scripts.push(args.at(-1));
    return { stdout: args.at(-1).startsWith("output volume") ? "72\n" : "" };
  };
  const ducker = new OutputVolumeDucker({ platform: "darwin", readConfig: async () => ({}), duckPercent: 10, exec });

  await ducker.duck();
  await ducker.restore();

  assert.deepEqual(scripts, [
    "output volume of (get volume settings)",
    "set volume output volume 10",
    "set volume output volume 72"
  ]);
});

test("una restauración inmediata espera a que termine primero el ducking", async () => {
  const changes = [];
  let finishDuck;
  const duckPending = new Promise((resolve) => { finishDuck = resolve; });
  const exec = async (_command, args) => {
    if (args.includes("sinks")) return { stdout: JSON.stringify([
      { name: "speaker", state: "RUNNING", volume: { left: { value_percent: "50%" } } }
    ]) };
    if (args[0] === "set-sink-volume" && args[2] === "10%") await duckPending;
    changes.push(args[2]);
    return { stdout: "" };
  };
  const ducker = new OutputVolumeDucker({ platform: "linux", readConfig: async () => ({ outputDeviceId: "speaker" }), exec });
  const duck = ducker.duck();
  const restore = ducker.restore();
  await Promise.resolve();
  assert.deepEqual(changes, []);
  finishDuck();
  await Promise.all([duck, restore]);
  assert.deepEqual(changes, ["10%", "50%"]);
});
