import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WakeWordModelStore } from "./wake-word-model-store.js";

async function fixture(now = () => new Date("2026-07-28T12:00:00.000Z")) {
  const rootPath = await mkdtemp(join(tmpdir(), "ha-wake-word-"));
  const store = new WakeWordModelStore({ rootPath, now });
  await store.initialize();
  return { store, rootPath };
}

test("crea y lista modelos sin versiones", async (context) => {
  const { store, rootPath } = await fixture();
  context.after(() => rm(rootPath, { recursive: true, force: true }));
  await store.create({ id: "hola-casa", name: "Hola casa", wakeWord: "Hola casa" });
  const models = await store.list();
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "hola-casa");
  assert.equal(models[0].file, null);
  assert.deepEqual(models[0].samples, { positive: 0, negative: 0 });
});

test("reemplaza el único archivo y avanza siempre su timestamp", async (context) => {
  const { store, rootPath } = await fixture();
  context.after(() => rm(rootPath, { recursive: true, force: true }));
  await store.create({ id: "memo", name: "Memo", wakeWord: "Memo" });
  const first = await store.replaceModelFile("memo", Buffer.from("primer modelo"), "memo.onnx");
  const second = await store.replaceModelFile("memo", Buffer.from("segundo modelo"), "memo.onnx");
  assert.equal(first.file.modifiedAt, "2026-07-28T12:00:00.000Z");
  assert.equal(second.file.modifiedAt, "2026-07-28T12:00:00.001Z");
  assert.notEqual(first.file.sha256, second.file.sha256);
  assert.equal((await readFile(store.modelPath("memo"))).toString(), "segundo modelo");
  assert.equal((await stat(store.modelPath("memo"))).mtime.toISOString(), second.file.modifiedAt);
});

test("acumula muestras positivas y negativas", async (context) => {
  const { store, rootPath } = await fixture(() => new Date("2026-07-28T12:00:00.000Z"));
  context.after(() => rm(rootPath, { recursive: true, force: true }));
  await store.create({ id: "memo", name: "Memo", wakeWord: "Memo" });
  await store.addSample("memo", "positive", Buffer.from("wav positivo"), "persona-1.wav");
  const result = await store.addSample("memo", "negative", Buffer.from("wav negativo"), "television.wav");
  assert.deepEqual(result.samples, { positive: 1, negative: 1 });
  assert.match(await store.latestSampleModifiedAt("memo"), /^2026-/);
});
