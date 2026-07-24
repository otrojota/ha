import assert from "node:assert/strict";
import test from "node:test";
import { createPlayMusicTool } from "./play-music.tool.js";
import { createSetActiveMusicDestinationTool } from "./set-active-destination.tool.js";
import { createListLibraryRadiosTool } from "./list-library-radios.tool.js";
import { createListMusicSourcesTool } from "./list-sources.tool.js";
import { createSetActiveMusicSourceTool } from "./set-active-source.tool.js";
import { createGetMusicPlaybackTool } from "./get-playback.tool.js";
import { createGetMusicQueueTool } from "./get-queue.tool.js";

test("music_play pasa el destino mencionado para activarlo y reproducir", async () => {
  let received;
  const tool = createPlayMusicTool({
    music: {
      async play(command) {
        received = command;
        return { status: "playing", item: { name: "Pink Floyd" }, destination: { name: "DMP-A6" } };
      }
    }
  });
  const result = await tool.execute({ query: "Pink Floyd", destination: "DMP-A6" });
  assert.deepEqual(received, { query: "Pink Floyd", destination: "DMP-A6", mode: "auto", searches: [], shuffle: true });
  assert.equal(result.destination, "DMP-A6");
});

test("music_play fuerza orden normal al reproducir un álbum completo", async () => {
  let received;
  const tool = createPlayMusicTool({ music: { async play(command) {
    received = command;
    return { status: "playing", item: { name: "In the Flesh?" }, destination: { name: "DMP-A6" } };
  } } });

  await tool.execute({ query: "The Wall Pink Floyd", mode: "album", shuffle: true });

  assert.equal(received.mode, "album");
  assert.equal(received.shuffle, false);
});

test("music_play conserva el ranking al pedir las más populares", async () => {
  let received;
  const tool = createPlayMusicTool({ music: { async play(command) {
    received = command;
    return { status: "playing", item: { name: "Queen" }, destination: { name: "DMP-A6" } };
  } } });

  await tool.execute({ query: "Queen", mode: "popular" });

  assert.equal(received.mode, "popular");
  assert.equal(received.shuffle, false);
});

test("music_play admite el modo radio para resolver emisoras de la biblioteca", async () => {
  let received;
  const tool = createPlayMusicTool({ music: { async play(command) {
    received = command;
    return { status: "playing", item: { name: "Radio Bío-Bío" }, destination: { name: "Satélite" }, source: { name: "RadioBrowser" } };
  } } });

  const result = await tool.execute({ query: "BioBio", mode: "radio" });

  assert.equal(received.mode, "radio");
  assert.equal(received.source, undefined);
  assert.equal(result.source, "RadioBrowser");
});

test("music_set_active_destination delega la validación al gateway", async () => {
  const tool = createSetActiveMusicDestinationTool({
    music: { setActiveDestination: async (destination) => ({ id: "ma:dmp", name: destination, active: true }) }
  });
  assert.deepEqual(await tool.execute({ destination: "Eversolo" }), {
    id: "ma:dmp", name: "Eversolo", active: true
  });
});

test("music_list_library_radios devuelve emisoras y no orígenes", async () => {
  const tool = createListLibraryRadiosTool({ music: { async getLibraryRadios() {
    return { total: 2, radios: [
      { name: "Radio Bío-Bío", provider: "radiobrowser--chile", uri: "library://radio/1" },
      { name: "Cooperativa", provider: "radiobrowser--chile", uri: "library://radio/2" }
    ] };
  } } });

  const result = await tool.execute({}, { satelliteId: "rpi" });

  assert.deepEqual(result.radios.map((radio) => radio.name), ["Radio Bío-Bío", "Cooperativa"]);
  assert.equal(result.total, 2);
});

test("las tools de origen propagan el satélite actual", async () => {
  const calls = [];
  const music = {
    async getSources(satelliteId) { calls.push(["list", satelliteId]); return { sources: [] }; },
    async setActiveSource(source, satelliteId) { calls.push(["set", source, satelliteId]); return { name: source }; }
  };
  const listTool = createListMusicSourcesTool({ music });
  const setTool = createSetActiveMusicSourceTool({ music });

  await listTool.execute({}, { satelliteId: "satellite-rpi" });
  await setTool.execute({ source: "Tidal" }, { satelliteId: "satellite-mac" });

  assert.deepEqual(calls, [["list", "satellite-rpi"], ["set", "Tidal", "satellite-mac"]]);
});

test("music_get_playback consulta un parlante explícito aunque sea de otro contexto", async () => {
  const calls = [];
  const tool = createGetMusicPlaybackTool({ music: { async getPlayback(destination, satelliteId) {
    calls.push([destination, satelliteId]);
    return { status: "playing", destination: { name: destination } };
  } } });

  await tool.execute({ destination: "Eversolo 2" }, { satelliteId: "satellite-rpi" });

  assert.deepEqual(calls, [["Eversolo 2", "satellite-rpi"]]);
});

test("music_get_queue expone la canción actual y la siguiente", async () => {
  const calls = [];
  const tool = createGetMusicQueueTool({ music: { async getQueue(destination, satelliteId) {
    calls.push([destination, satelliteId]);
    return {
      destination: { name: "Satélite 1" }, currentIndex: 2,
      current: { name: "Actual" }, next: { name: "Siguiente" },
      upcoming: [{ name: "Siguiente" }, { name: "Después" }]
    };
  } } });

  const result = await tool.execute({ destination: "Satélite 1" }, { satelliteId: "rpi" });

  assert.deepEqual(calls, [["Satélite 1", "rpi"]]);
  assert.equal(result.current.name, "Actual");
  assert.equal(result.next.name, "Siguiente");
  assert.equal(result.totalUpcoming, 2);
});
