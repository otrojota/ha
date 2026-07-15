import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MusicCreditsService } from "./music-credits.js";

const playback = (item = {}) => ({
  status: "playing",
  device: { name: "DMP-A6" },
  item: {
    name: "Gente Cansada",
    album: "Aforismos",
    artists: ["Proyecto Jota"],
    isrc: "CL-AAA-26-00001",
    ...item
  }
});

test("prioriza créditos locales identificados por ISRC", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ha-credits-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const localPath = join(directory, "credits.json");
  await writeFile(localPath, JSON.stringify({ credits: [{
    isrc: "CL-AAA-26-00001",
    vocalists: ["Cantante invitada"],
    performers: [{ name: "Música invitada", role: "guitarra" }],
    composers: ["Compositor real"]
  }] }));
  const service = new MusicCreditsService({ localPath, fetchImpl: async () => new Response("no disponible", { status: 404 }) });

  const result = await service.getCurrentCredits(playback());

  assert.deepEqual(result.vocalists, ["Cantante invitada"]);
  assert.deepEqual(result.performers, [{ name: "Música invitada", role: "guitarra" }]);
  assert.equal(result.detailedCreditsAvailable, true);
  assert.equal(result.limitation, null);
  assert.ok(result.sources.includes("local"));
});

test("obtiene vocalistas, instrumentos y producción desde MusicBrainz", async () => {
  const service = new MusicCreditsService({
    fetchImpl: async (url, options) => {
      assert.match(url, /\/ws\/2\/isrc\/CL-AAA-26-00001/);
      assert.equal(options.headers["User-Agent"], "HA-Voice-Assistant/0.1");
      return Response.json({ recordings: [{ relations: [
        { type: "vocal", attributes: ["lead vocals"], artist: { name: "Ana Voz" } },
        { type: "instrument", attributes: ["guitar"], artist: { name: "Beto Guitarra" } },
        { type: "producer", attributes: [], artist: { name: "Carla Producción" } }
      ] }] });
    }
  });

  const result = await service.getCurrentCredits(playback());

  assert.deepEqual(result.vocalists, ["Ana Voz"]);
  assert.deepEqual(result.performers, [
    { name: "Ana Voz", role: "lead vocals" },
    { name: "Beto Guitarra", role: "guitar" }
  ]);
  assert.deepEqual(result.producers, ["Carla Producción"]);
  assert.ok(result.sources.includes("musicbrainz"));
});

test("distingue el artista acreditado cuando no existen créditos detallados", async () => {
  const service = new MusicCreditsService({ fetchImpl: async () => Response.json({ recordings: [] }) });
  const result = await service.getCurrentCredits(playback({ isrc: null }));
  assert.deepEqual(result.creditedArtists, ["Proyecto Jota"]);
  assert.equal(result.detailedCreditsAvailable, false);
  assert.match(result.limitation, /artista acreditado/);
});
