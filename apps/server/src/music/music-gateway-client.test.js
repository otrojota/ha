import assert from "node:assert/strict";
import test from "node:test";
import { MusicGatewayClient } from "./music-gateway-client.js";

test("envía satelliteId al listar y cambiar el origen activo", async () => {
  const requests = [];
  const client = new MusicGatewayClient({ fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ sources: [] }) };
  } });

  await client.getSources("satellite-rpi");
  await client.setActiveSource("RadioBrowser", "satellite-mac");

  assert.equal(requests[0].options.headers["X-Satellite-Id"], "satellite-rpi");
  assert.equal(requests[1].options.headers["X-Satellite-Id"], "satellite-mac");
  assert.deepEqual(JSON.parse(requests[1].options.body), { target: "RadioBrowser" });
});

test("rechaza operaciones musicales sin identidad de satélite", async () => {
  const client = new MusicGatewayClient({ fetchImpl: async () => { throw new Error("no debe consultar"); } });
  await assert.rejects(() => client.getSources(), /Falta satelliteId/);
});

test("consulta un destino explícito sin perder el alcance del satélite", async () => {
  let request;
  const client = new MusicGatewayClient({ fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ status: "playing" }) };
  } });

  await client.getPlayback("Eversolo 2", "satellite-rpi");

  assert.equal(request.url, "http://localhost:3100/v1/music/playback?destination=Eversolo%202");
  assert.equal(request.options.headers["X-Satellite-Id"], "satellite-rpi");
});

test("consulta la cola de un destino explícito", async () => {
  let request;
  const client = new MusicGatewayClient({ fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ items: [] }) };
  } });

  await client.getQueue("Satélite 1", "satellite-rpi");

  assert.equal(request.url, "http://localhost:3100/v1/music/queue?destination=Sat%C3%A9lite%201");
  assert.equal(request.options.headers["X-Satellite-Id"], "satellite-rpi");
});

test("consulta playlists disponibles con alcance de satélite", async () => {
  let request;
  const client = new MusicGatewayClient({ fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ playlists: [] }) };
  } });

  await client.getLibraryPlaylists("satellite-rpi");

  assert.equal(request.url, "http://localhost:3100/v1/music/playlists");
  assert.equal(request.options.headers["X-Satellite-Id"], "satellite-rpi");
});
