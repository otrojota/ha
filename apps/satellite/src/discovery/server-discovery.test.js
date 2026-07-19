import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDiscoveredServer } from "./server-discovery.js";

test("normaliza un anuncio mDNS como endpoints consumibles", () => {
  const server = normalizeDiscoveredServer({
    name: "Casa", host: "casa.local", port: 3000,
    referer: { address: "192.168.1.30" },
    addresses: ["172.17.0.1", "192.168.1.21", "fe80::1", "127.0.0.1"],
    txt: { id: "server-1", name: "Casa", protocolVersion: "2" }
  });
  assert.equal(server.address, "192.168.1.21");
  assert.equal(server.webSocketUrl, "ws://192.168.1.21:3000/ws");
  assert.equal(server.speechToTextUrl, "http://192.168.1.21:3000/stt/transcribe");
  assert.equal(server.musicApiUrl, "http://192.168.1.21:3100/v1");
});

test("usa la IP anunciada por el servidor y no la interfaz receptora del satélite", () => {
  const server = normalizeDiscoveredServer({
    name: "macserver", host: "ha-server.local", port: 3000,
    referer: { address: "192.168.0.147" },
    addresses: ["172.17.0.1", "192.168.0.45"],
    txt: { id: "fedora-server", name: "macserver", protocolVersion: "2" }
  });

  assert.equal(server.address, "192.168.0.45");
  assert.equal(server.webSocketUrl, "ws://192.168.0.45:3000/ws");
});

test("rechaza anuncios que no tienen identidad o IPv4 utilizable", () => {
  assert.equal(normalizeDiscoveredServer({ port: 3000, addresses: ["127.0.0.1"], txt: { id: "server-1", name: "Casa", protocolVersion: "2" } }), null);
  assert.equal(normalizeDiscoveredServer({ port: 3000, addresses: ["192.168.1.21"], txt: {} }), null);
  assert.equal(normalizeDiscoveredServer({ port: 3000, addresses: ["192.168.1.21"], txt: { id: "old", name: "Antiguo", protocolVersion: "1" } }), null);
});
