import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WakeWordModelManager } from "./wake-word-model-manager.js";

const remoteModel = {
  id: "pantallita",
  name: "Pantallita",
  wakeWord: "Pantallita",
  file: {
    name: "pantallita.onnx",
    size: 10,
    modifiedAt: "2026-07-28T20:00:00.000Z",
    sha256: "new-sha"
  }
};

test("informa si el modelo remoto cambió respecto de la copia local", async (context) => {
  const rootPath = await mkdtemp(join(tmpdir(), "ha-wake-models-"));
  context.after(() => rm(rootPath, { recursive: true, force: true }));
  const directory = join(rootPath, "pantallita");
  await mkdir(directory);
  await writeFile(join(directory, "model.json"), JSON.stringify({
    ...remoteModel,
    file: { ...remoteModel.file, modifiedAt: "2026-07-27T20:00:00.000Z", sha256: "old-sha" }
  }));
  const manager = new WakeWordModelManager({
    rootPath,
    serverProvider: () => ({ httpUrl: "http://server.test" }),
    fetchImpl: async () => new Response(JSON.stringify({ models: [remoteModel] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  });
  const [model] = await manager.catalog();
  assert.equal(model.updateAvailable, true);
  assert.equal(model.local.downloaded, false);
  assert.equal(model.file.sha256, "new-sha");
});

test("ofrece actualizar si cambió el timestamp aunque el SHA sea idéntico", async (context) => {
  const rootPath = await mkdtemp(join(tmpdir(), "ha-wake-models-"));
  context.after(() => rm(rootPath, { recursive: true, force: true }));
  const directory = join(rootPath, "pantallita");
  await mkdir(directory);
  await writeFile(join(directory, "model.json"), JSON.stringify({
    ...remoteModel,
    file: { ...remoteModel.file, modifiedAt: "2026-07-27T20:00:00.000Z" }
  }));
  const manager = new WakeWordModelManager({
    rootPath,
    serverProvider: () => ({ httpUrl: "http://server.test" }),
    fetchImpl: async () => new Response(JSON.stringify({ models: [remoteModel] }))
  });
  const [model] = await manager.catalog();
  assert.equal(model.updateAvailable, true);
  assert.equal(model.local.downloaded, false);
});

test("solicita al servidor entrenar inmediatamente el modelo seleccionado", async () => {
  let request = null;
  const manager = new WakeWordModelManager({
    rootPath: "/unused",
    serverProvider: () => ({ httpUrl: "http://server.test" }),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ job: { id: "job-1", status: "queued" } }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  const result = await manager.train("pantallita");

  assert.equal(request.url, "http://server.test/api/wake-word/models/pantallita/train");
  assert.equal(request.options.method, "POST");
  assert.equal(result.job.id, "job-1");
});

test("envía una detección falsa como WAV negativo al modelo seleccionado", async () => {
  let request = null;
  const manager = new WakeWordModelManager({
    rootPath: "/unused",
    serverProvider: () => ({ httpUrl: "http://server.test" }),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ model: remoteModel }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  const audio = Buffer.concat([Buffer.alloc(44), Buffer.from([1, 2, 3, 4])]);
  await manager.addNegativeSample("pantallita", audio, "false-detection.wav");
  assert.equal(request.url, "http://server.test/api/wake-word/models/pantallita/samples/negative");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["Content-Type"], "audio/wav");
  assert.equal(request.options.headers["X-File-Name"], "false-detection.wav");
  assert.deepEqual(request.options.body, audio);
});

test("envía una activación confirmada como WAV positivo", async () => {
  let request = null;
  const manager = new WakeWordModelManager({
    rootPath: "/unused",
    serverProvider: () => ({ httpUrl: "http://server.test" }),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response("{}", { status: 201 });
    }
  });
  await manager.addPositiveSample("pantallita", Buffer.alloc(48), "accepted.wav");
  assert.equal(request.url, "http://server.test/api/wake-word/models/pantallita/samples/positive");
  assert.equal(request.options.headers["X-File-Name"], "accepted.wav");
});
