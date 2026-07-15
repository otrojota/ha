import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDiscoveredServer } from "./server-discovery.js";
import { serverFromManualUrl } from "./server-selection.js";

test("normaliza un anuncio mDNS como endpoints consumibles", () => {
  const server = normalizeDiscoveredServer({
    name: "Casa", host: "casa.local", port: 3000,
    referer: { address: "192.168.1.21" },
    addresses: ["172.17.0.1", "fe80::1", "127.0.0.1"],
    txt: { id: "server-1", wsPath: "/ws", sttPath: "/stt/transcribe", protocolVersion: "1" }
  });
  assert.equal(server.address, "192.168.1.21");
  assert.equal(server.webSocketUrl, "ws://192.168.1.21:3000/ws");
  assert.equal(server.speechToTextUrl, "http://192.168.1.21:3000/stt/transcribe");
  assert.equal(server.musicApiUrl, "http://192.168.1.21:3100/v1");
});

test("rechaza anuncios que no tienen identidad o IPv4 utilizable", () => {
  assert.equal(normalizeDiscoveredServer({ port: 3000, addresses: ["127.0.0.1"], txt: { id: "server-1" } }), null);
  assert.equal(normalizeDiscoveredServer({ port: 3000, addresses: ["192.168.1.21"], txt: {} }), null);
});

test("deriva los endpoints del override SERVER_URL", () => {
  const server = serverFromManualUrl("ws://10.0.0.5:3000/ws");
  assert.equal(server.httpUrl, "http://10.0.0.5:3000");
  assert.equal(server.speechToTextUrl, "http://10.0.0.5:3000/stt/transcribe");
  assert.equal(server.musicApiUrl, "http://10.0.0.5:3100/v1");
});
