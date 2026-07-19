import test from "node:test";
import assert from "node:assert/strict";
import { isAssistantNameOnly, isMeaningfulVoiceCommand, normalizeVoiceText } from "./voice-command.js";

test("normaliza puntuación y acentos para comparar el nombre del asistente", () => {
  assert.equal(normalizeVoiceText("  ¡Ámigo!  "), "amigo");
  assert.equal(isAssistantNameOnly("Amigo.", "Ámigo"), true);
});

test("el nombre aislado no se confunde con un comando que lo contiene", () => {
  assert.equal(isAssistantNameOnly("Amigo", "Amigo"), true);
  assert.equal(isAssistantNameOnly("Amigo, reproduce música", "Amigo"), false);
  assert.equal(isMeaningfulVoiceCommand("Amigo, reproduce música"), true);
});
