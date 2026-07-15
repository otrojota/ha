import assert from "node:assert/strict";
import test from "node:test";
import { responseExpectsReply } from "./assistant-response.js";

test("reconoce respuestas que esperan una contestación", () => {
  assert.equal(responseExpectsReply("Encontré varias opciones. ¿Quieres que busque la más cercana?"), true);
  assert.equal(responseExpectsReply("¿Para qué hora quieres la alarma?"), true);
});

test("no abre seguimiento para respuestas informativas", () => {
  assert.equal(responseExpectsReply("La alarma quedó programada para las cinco."), false);
  assert.equal(responseExpectsReply("No pude completar la solicitud."), false);
});
