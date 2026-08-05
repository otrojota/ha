import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WakeWordModelStore } from "./wake-word-model-store.js";
import { WakeWordTrainingService } from "./wake-word-training-service.js";

test("entrena en segundo plano y reemplaza el archivo vigente", async (context) => {
  const rootPath = await mkdtemp(join(tmpdir(), "ha-wake-training-"));
  context.after(() => rm(rootPath, { recursive: true, force: true }));
  const store = new WakeWordModelStore({ rootPath });
  await store.create({ id: "memo", name: "Memo", wakeWord: "Memo" });
  const spawnProcess = (_executable, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const output = args[args.indexOf("--output") + 1];
    queueMicrotask(async () => {
      await writeFile(output, "onnx generado");
      child.emit("exit", 0, null);
    });
    return child;
  };
  const service = new WakeWordTrainingService({ store, executable: "/trainer", spawnProcess });
  const job = await service.start("memo");
  while (service.job(job.id).status === "queued" || service.job(job.id).status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(service.job(job.id).status, "completed");
  assert.equal((await store.readModelFile("memo")).buffer.toString(), "onnx generado");
});

test("evalúa una muestra sin almacenarla en el modelo", async (context) => {
  const rootPath = await mkdtemp(join(tmpdir(), "ha-wake-evaluation-"));
  context.after(() => rm(rootPath, { recursive: true, force: true }));
  const store = new WakeWordModelStore({ rootPath });
  await store.create({ id: "memo", name: "Memo", wakeWord: "Memo" });
  await store.replaceModelFile("memo", Buffer.from("onnx"), "memo.onnx");
  const spawnProcess = (_executable, args) => {
    assert.equal(args[0], "--evaluate");
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit("data", '{"score":0.998,"threshold":0.995,"activated":true}');
      child.emit("exit", 0, null);
    });
    return child;
  };
  const service = new WakeWordTrainingService({ store, executable: "/trainer", spawnProcess });
  const result = await service.evaluate("memo", Buffer.from("wav"));
  assert.equal(result.activated, true);
  assert.equal(result.score, 0.998);
  assert.equal((await store.describe("memo")).samples.positive, 0);
});

test("inicia autoentrenamiento cuando hay muestras posteriores al ONNX", async () => {
  const store = {
    list: async () => [{
      id: "memo",
      file: { modifiedAt: "2026-07-28T12:00:00.000Z" }
    }],
    latestSampleModifiedAt: async () => "2026-07-28T12:01:00.000Z"
  };
  const service = new WakeWordTrainingService({ store, executable: "/trainer" });
  const started = [];
  service.start = async (modelId) => {
    started.push(modelId);
    return { id: "job-1", modelId };
  };
  const jobs = await service.scanAutomatic();
  assert.deepEqual(started, ["memo"]);
  assert.equal(jobs[0].modelId, "memo");
});

test("no reentrena si el ONNX es posterior a las últimas muestras", async () => {
  const store = {
    list: async () => [{
      id: "memo",
      file: { modifiedAt: "2026-07-28T12:02:00.000Z" }
    }],
    latestSampleModifiedAt: async () => "2026-07-28T12:01:00.000Z"
  };
  const service = new WakeWordTrainingService({ store, executable: "/trainer" });
  service.start = async () => assert.fail("no debía iniciar entrenamiento");
  assert.deepEqual(await service.scanAutomatic(), []);
});
