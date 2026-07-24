import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SendspinPlayer } from "./sendspin-player.js";

function fakeSpawnedProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test("Linux routes a selected PipeWire sink through Pulse for Sendspin", async () => {
  const commands = [];
  const spawns = [];
  const player = new SendspinPlayer({
    executable: "sendspin",
    satelliteId: "memo",
    platform: "linux",
    run: async (command, args) => commands.push([command, args]),
    spawnProcess: (command, args) => {
      spawns.push([command, args]);
      return fakeSpawnedProcess();
    }
  });
  await player.start({ musicOutputDeviceId: "alsa_output.platform.internal" });
  player.stop();
  assert.deepEqual(commands, [["pactl", ["set-default-sink", "alsa_output.platform.internal"]]]);
  assert.deepEqual(spawns[0], ["sendspin", [
    "daemon", "--id", "ha-memo", "--name", "HA Satellite memo",
    "--manufacturer", "HA Voice Assistant", "--product-name", "Satellite Speaker",
    "--audio-device", "pulse"
  ]]);
});

test("non-Linux platforms preserve the configured Sendspin device", async () => {
  const spawns = [];
  const player = new SendspinPlayer({
    executable: "sendspin",
    satelliteId: "desk",
    platform: "darwin",
    run: async () => assert.fail("pactl must not be called"),
    spawnProcess: (command, args) => {
      spawns.push([command, args]);
      return fakeSpawnedProcess();
    }
  });
  await player.start({ musicOutputDeviceId: "CoreAudio Speaker" });
  player.stop();
  assert.equal(spawns[0][1].at(-1), "CoreAudio Speaker");
});
