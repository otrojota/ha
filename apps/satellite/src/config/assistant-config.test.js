import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAssistantConfig, writeAssistantConfig } from "./assistant-config.js";

test("la activación por wake word está habilitada por defecto", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-assistant-config-"));
  try {
    const path = join(directory, "assistant.json");
    assert.deepEqual(await readAssistantConfig(path, () => {}), {
      name: "Asistente", wakeWordEnabled: true, wakeWordMode: "vosk",
      wakeWordModelId: null, wakeWordTrainingMode: false, connectedPowerDeviceId: null
    });
    await writeFile(path, '{"name":"Amigo"}\n');
    assert.deepEqual(await readAssistantConfig(path, () => {}), {
      name: "Amigo", wakeWordEnabled: true, wakeWordMode: "vosk",
      wakeWordModelId: null, wakeWordTrainingMode: false, connectedPowerDeviceId: null
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("conserva la desactivación explícita de la wake word", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-assistant-config-"));
  try {
    const path = join(directory, "assistant.json");
    await writeAssistantConfig(path, {
      name: "Jota", wakeWordEnabled: false, wakeWordMode: "vosk",
      wakeWordModelId: null, wakeWordTrainingMode: false, connectedPowerDeviceId: "switch.enchufe_jota"
    });
    assert.deepEqual(await readAssistantConfig(path, () => {}), {
      name: "Jota", wakeWordEnabled: false, wakeWordMode: "vosk",
      wakeWordModelId: null, wakeWordTrainingMode: false, connectedPowerDeviceId: "switch.enchufe_jota"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("conserva la selección de un modelo entrenado", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-assistant-config-"));
  try {
    const path = join(directory, "assistant.json");
    await writeFile(path, JSON.stringify({
      name: "Pantallita",
      wakeWordEnabled: true,
      wakeWordMode: "model",
      wakeWordModelId: "pantallita",
      wakeWordTrainingMode: true,
      connectedPowerDeviceId: null
    }));
    assert.deepEqual(await readAssistantConfig(path, () => {}), {
      name: "Pantallita",
      wakeWordEnabled: true,
      wakeWordMode: "model",
      wakeWordModelId: "pantallita",
      wakeWordTrainingMode: true,
      connectedPowerDeviceId: null
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
