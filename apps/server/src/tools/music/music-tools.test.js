import assert from "node:assert/strict";
import test from "node:test";
import { createPlayMusicTool } from "./play-music.tool.js";
import { createSetActiveMusicDestinationTool } from "./set-active-destination.tool.js";

test("music_play pasa el destino mencionado para activarlo y reproducir", async () => {
  let received;
  const tool = createPlayMusicTool({
    music: {
      async play(command) {
        received = command;
        return { status: "playing", item: { name: "Pink Floyd" }, destination: { name: "DMP-A6", alias: "Eversolo" } };
      }
    }
  });
  const result = await tool.execute({ query: "Pink Floyd", destination: "DMP-A6" });
  assert.deepEqual(received, { query: "Pink Floyd", destination: "DMP-A6", mode: "auto", searches: [], shuffle: true });
  assert.equal(result.destination, "Eversolo");
});

test("music_set_active_destination delega la validación al gateway", async () => {
  const tool = createSetActiveMusicDestinationTool({
    music: { setActiveDestination: async (destination) => ({ id: "spotify:dmp", name: destination, active: true }) }
  });
  assert.deepEqual(await tool.execute({ destination: "Eversolo" }), {
    id: "spotify:dmp", name: "Eversolo", room: undefined, active: true
  });
});
