import assert from "node:assert/strict";
import test from "node:test";
import { resolveMusicArtworkUrl } from "./music-artwork.js";

test("conserva el prefijo del proxy al resolver una portada de Music Gateway", () => {
  assert.equal(
    resolveMusicArtworkUrl(
      "/v1/artwork?proxyId=cover-123",
      "https://ha-server.local/music-gateway/v1"
    ),
    "https://ha-server.local/music-gateway/v1/artwork?proxyId=cover-123"
  );
});

test("acepta portadas absolutas y rutas relativas al API", () => {
  assert.equal(
    resolveMusicArtworkUrl("https://images.example/cover.jpg", "https://ha-server.local/music-gateway/v1"),
    "https://images.example/cover.jpg"
  );
  assert.equal(
    resolveMusicArtworkUrl("artwork?proxyId=cover-456", "https://ha-server.local/music-gateway/v1"),
    "https://ha-server.local/music-gateway/v1/artwork?proxyId=cover-456"
  );
});
