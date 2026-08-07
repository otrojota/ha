import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VoiceConfigStore } from "./voice-config-store.js";

test("persiste una voz por satelliteId y usa la primera como valor predeterminado", async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-tts-"));
  const path = join(root, "tts.json");
  const voices = [{ id: "uno" }, { id: "dos" }];
  const store = new VoiceConfigStore({ path });
  await store.initialize();
  assert.equal(store.voiceFor("cocina", voices), "uno");
  await store.assign("cocina", "dos", voices);
  const restored = new VoiceConfigStore({ path });
  await restored.initialize();
  assert.equal(restored.voiceFor("cocina", voices), "dos");
  await assert.rejects(() => restored.assign("cocina", "tres", voices), /no está disponible/);
});
