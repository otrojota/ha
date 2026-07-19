import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServerSelection } from "./server-selection.js";

class FakeDiscovery {
  constructor(servers = []) { this.servers = servers; this.onChanged = () => {}; }
  start() {}
  stop() {}
  refresh() {}
  list() { return this.servers; }
  change(servers) { this.servers = servers; this.onChanged(servers); }
}

const server = (id, address) => ({
  id, name: id, address, port: 3000, protocolVersion: "2", available: true,
  httpUrl: `http://${address}:3000`, webSocketUrl: `ws://${address}:3000/ws`,
  speechToTextUrl: `http://${address}:3000/stt/transcribe`, musicApiUrl: `http://${address}:3100/v1`
});

test("selecciona y persiste automáticamente el único servidor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-server-selection-"));
  const path = join(directory, "server.json");
  const discovery = new FakeDiscovery([server("one", "192.168.1.10")]);
  const selected = [];
  const selection = new ServerSelection({ discovery, configPath: path, onSelected: (value) => selected.push(value) });
  await selection.start();
  assert.equal(selection.state().selected.id, "one");
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.selectedServerId, "one");
  assert.equal(persisted.lastServer.webSocketUrl, "ws://192.168.1.10:3000/ws");
  assert.equal(selected.at(-1).address, "192.168.1.10");
});

test("usa el último endpoint mientras el servidor seleccionado todavía no aparece por mDNS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-server-selection-"));
  const path = join(directory, "server.json");
  const previous = server("fedora", "192.168.0.45");
  const first = new ServerSelection({ discovery: new FakeDiscovery([previous]), configPath: path });
  await first.start();
  first.stop();

  const selected = [];
  const discovery = new FakeDiscovery([]);
  const restarted = new ServerSelection({ discovery, configPath: path, onSelected: (value) => selected.push(value) });
  await restarted.start();
  assert.equal(restarted.state().selected.id, "fedora");
  assert.equal(restarted.state().selected.cached, true);
  assert.equal(restarted.state().selected.webSocketUrl, "ws://192.168.0.45:3000/ws");

  discovery.change([server("fedora", "192.168.0.46")]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarted.state().selected.address, "192.168.0.46");
  assert.equal(restarted.state().selected.cached, undefined);
  assert.equal(selected.at(-1).address, "192.168.0.46");
});

test("exige selección cuando se descubren varios y recuerda el elegido", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-server-selection-"));
  const path = join(directory, "server.json");
  const discovery = new FakeDiscovery([server("one", "192.168.1.10"), server("two", "192.168.1.20")]);
  const selection = new ServerSelection({ discovery, configPath: path });
  await selection.start();
  assert.equal(selection.state().selectionRequired, true);
  await selection.select("two");
  assert.equal(selection.state().selected.id, "two");
  discovery.change([server("two", "192.168.1.99")]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selection.state().selected.address, "192.168.1.99");
});
