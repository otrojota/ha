import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createMusicGatewayProxy } from "./music-gateway-proxy.js";

function responseCapture() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body = "") { this.body = body; }
  };
}

test("expone Music Gateway bajo el mismo origen del servidor", async () => {
  let forwarded;
  const proxy = createMusicGatewayProxy({
    baseUrl: "http://127.0.0.1:3100",
    fetchImpl: async (url, options) => {
      forwarded = { url: url.toString(), options };
      return new Response(JSON.stringify({ destinations: [] }), { headers: { "Content-Type": "application/json" } });
    }
  });
  const request = Readable.from([]);
  Object.assign(request, { method: "GET", url: "/music-gateway/v1/destinations", headers: { "x-satellite-id": "sat-1" } });
  const response = responseCapture();
  assert.equal(await proxy(request, response), true);
  assert.equal(forwarded.url, "http://127.0.0.1:3100/v1/destinations");
  assert.equal(forwarded.options.headers.get("x-satellite-id"), "sat-1");
  assert.deepEqual(JSON.parse(response.body.toString()), { destinations: [] });
});

test("ignora rutas que no pertenecen al proxy", async () => {
  const proxy = createMusicGatewayProxy({ baseUrl: "http://127.0.0.1:3100" });
  assert.equal(await proxy({ method: "GET", url: "/health" }, responseCapture()), false);
});
