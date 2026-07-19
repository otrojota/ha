import assert from "node:assert/strict";
import test from "node:test";
import { removeGenericFollowUp, responseExpectsReply } from "./assistant-response.js";

test("reconoce respuestas que esperan una contestación", () => {
  assert.equal(responseExpectsReply("Encontré varias opciones. ¿Quieres que busque la más cercana?"), true);
  assert.equal(responseExpectsReply("¿Para qué hora quieres la alarma?"), true);
  assert.equal(responseExpectsReply(`Estas son las opciones disponibles: ${"una opción, ".repeat(40)}¿Cuál prefieres?`), true);
  assert.equal(responseExpectsReply('Encontré dos luces. Cuál quieres encender?"'), true);
  assert.equal(responseExpectsReply("Necesito un destino. Indícame en qué habitación."), true);
});

test("elimina preguntas genéricas de cortesía sin tocar aclaraciones reales", () => {
  assert.equal(removeGenericFollowUp("Listo, reanudé la reproducción. ¿Quieres algo más?"), "Listo, reanudé la reproducción.");
  assert.equal(removeGenericFollowUp("La luz quedó al 50%. ¿En qué más puedo ayudarte?"), "La luz quedó al 50%.");
  assert.equal(removeGenericFollowUp("Encontré dos radios. ¿Cuál prefieres?"), "Encontré dos radios. ¿Cuál prefieres?");
});

test("no abre seguimiento para respuestas informativas", () => {
  assert.equal(responseExpectsReply("La alarma quedó programada para las cinco."), false);
  assert.equal(responseExpectsReply("No pude completar la solicitud."), false);
});
