import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServerSelection, serverFromManualUrl } from "./server-selection.js";

class FakeDiscovery {
  constructor(servers = []) { this.servers = servers; this.onChanged = () => {}; }
  start() {}
  stop() {}
  refresh() {}
  list() { return this.servers; }
  change(servers) { this.servers = servers; this.onChanged(servers); }
}

const server = (id, address) => ({ id, name: id, address, port: 3000, available: true });

test("selecciona y persiste automáticamente el único servidor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-server-selection-"));
  const path = join(directory, "server.json");
  const discovery = new FakeDiscovery([server("one", "192.168.1.10")]);
  const selected = [];
  const selection = new ServerSelection({ discovery, configPath: path, onSelected: (value) => selected.push(value) });
  await selection.start();
  assert.equal(selection.state().selected.id, "one");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { selectedServerId: "one" });
  assert.equal(selected.at(-1).address, "192.168.1.10");
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

test("mantiene la ruta manual seleccionada pero también muestra servidores descubiertos", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-server-selection-"));
  const discovery = new FakeDiscovery([server("lan", "192.168.1.20")]);
  const selection = new ServerSelection({
    discovery,
    configPath: join(directory, "server.json"),
    manualServer: serverFromManualUrl("ws://localhost:3000/ws")
  });
  await selection.start();
  assert.equal(selection.state().selected.id, "manual");
  assert.deepEqual(selection.state().discovered.map((item) => item.id), ["manual", "lan"]);
  await selection.select("lan");
  assert.equal(selection.state().selected.id, "lan");
});
