import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ServerAdvertiser } from "./server-advertiser.js";

test("publica un nombre técnico único y conserva el nombre amigable en TXT", () => {
  let published;
  const service = new EventEmitter();
  service.stop = () => {};
  const bonjour = {
    publish: (config) => { published = config; return service; },
    destroy: () => {}
  };
  const advertiser = new ServerAdvertiser({
    identity: { id: "36c47af6-efd2-4f3d-b334-606ed6e3d949", name: "Servidor Casa" },
    port: 3000,
    bonjour
  });
  advertiser.start();
  assert.equal(published.name, "Servidor Casa [36c47af6]");
  assert.equal(published.host, "ha-server-36c47af6.local");
  assert.equal(published.txt.name, "Servidor Casa");
  assert.equal(published.txt.id, "36c47af6-efd2-4f3d-b334-606ed6e3d949");
  advertiser.stop();
});
