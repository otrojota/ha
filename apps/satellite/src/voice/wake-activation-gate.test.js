import assert from "node:assert/strict";
import test from "node:test";
import { OneShotCommandRetry, WakeActivationGate } from "./wake-activation-gate.js";

test("bloquea nuevas activaciones durante escucha y procesamiento", () => {
  const gate = new WakeActivationGate();
  assert.equal(gate.beginListening(), true);
  assert.equal(gate.beginListening(), false);
  assert.equal(gate.phase, "listening");
  gate.beginProcessing();
  assert.equal(gate.beginListening(), false);
  assert.equal(gate.phase, "processing");
  gate.end();
  assert.equal(gate.beginListening(), true);
});

test("permite una sola frase adicional después de recibir sólo la wake word", () => {
  const retry = new OneShotCommandRetry();
  retry.reset();
  assert.equal(retry.consume(), true);
  assert.equal(retry.consume(), false);
  retry.reset();
  retry.clear();
  assert.equal(retry.consume(), false);
});
