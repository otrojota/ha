import assert from "node:assert/strict";
import test from "node:test";
import { AssistantAgent } from "./assistant-agent.js";

function toolCall(name, args) {
  return { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] };
}

test("el tool calling del LLM es la fuente de intención y conserva sus argumentos", async () => {
  let turn = 0;
  const calls = [];
  const client = { async chat() {
    turn += 1;
    return { message: turn === 1
      ? toolCall("music_set_volume", { volumePercent: 50 })
      : { role: "assistant", content: "Volumen ajustado al cincuenta por ciento." } };
  } };
  const tools = { definitions: () => [], async execute(name, args, context) {
    calls.push({ name, args, satelliteId: context.satelliteId });
    return { requestedVolumePercent: 50 };
  } };

  const answer = await new AssistantAgent({ client, tools, log: () => {} })
    .respond("Sí, déjalo como te indiqué", { satelliteId: "rpi" });

  assert.deepEqual(calls, [{ name: "music_set_volume", args: { volumePercent: 50 }, satelliteId: "rpi" }]);
  assert.equal(answer, "Volumen ajustado al cincuenta por ciento.");
});

test("rechaza un brillo que contradice el porcentaje explícito del comando", async () => {
  let turn = 0;
  const executed = [];
  const client = { async chat(messages) {
    turn += 1;
    if (turn === 1) return { message: toolCall("light_set_brightness", { target: "Luz 1", brightnessPercent: 50 }) };
    assert.match(messages.at(-1).content, /pide 10%.*intentó usar 50%/);
    return { message: { role: "assistant", content: "No ejecuté el porcentaje incorrecto." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) { executed.push({ name, args }); } };
  const answer = await new AssistantAgent({ client, tools, log: () => {} })
    .respond("Baja la Luz 1 al 10%", { satelliteId: "test" });
  assert.equal(answer, "No ejecuté el porcentaje incorrecto.");
  assert.deepEqual(executed, []);
});

test("no reemplaza radio, origen ni destino elegidos por el LLM", async () => {
  let turn = 0;
  const calls = [];
  const expected = { query: "BioBio Chile", mode: "radio", destination: "Cocina" };
  const client = { async chat() {
    turn += 1;
    return { message: turn === 1 ? toolCall("music_play", expected) : { role: "assistant", content: "Reproduciendo BioBio Chile." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) { calls.push({ name, args }); return { status: "playing" }; } };

  await new AssistantAgent({ client, tools, log: () => {} }).respond("Pon una radio", { satelliteId: "test" });

  assert.deepEqual(calls, [{ name: "music_play", args: expected }]);
});

test("una respuesta sin tool no dispara acciones inferidas por expresiones regulares", async () => {
  const executed = [];
  const client = { async chat() { return { message: { role: "assistant", content: "¿Qué volumen prefieres?" } }; } };
  const tools = { definitions: () => [], async execute(name) { executed.push(name); } };

  const answer = await new AssistantAgent({ client, tools, log: () => {} }).respond("Ponlo más cómodo", { satelliteId: "test" });

  assert.equal(answer, "¿Qué volumen prefieres?");
  assert.deepEqual(executed, []);
});

test("no acepta que el LLM confirme una acción que no ejecutó", async () => {
  let turn = 0;
  const calls = [];
  const client = { async chat(messages) {
    turn += 1;
    if (turn === 1) return { message: { role: "assistant", content: "He pasado a la siguiente canción." } };
    if (turn === 2) {
      assert.match(messages.at(-1).content, /No ejecutaste ninguna herramienta/);
      return { message: toolCall("music_next", { destination: "Satélite 1" }) };
    }
    return { message: { role: "assistant", content: "Siguiente canción: Dos." } };
  }};
  const tools = { definitions: () => [], async execute(name, args) { calls.push({ name, args }); return { item: { name: "Dos" } }; } };

  const answer = await new AssistantAgent({ client, tools, log: () => {} })
    .respond("Siguiente canción", { satelliteId: "rpi" });

  assert.equal(answer, "Siguiente canción: Dos.");
  assert.deepEqual(calls, [{ name: "music_next", args: { destination: "Satélite 1" } }]);
});

test("mantiene un fallback local sólo para pausa de emergencia", async () => {
  const executed = [];
  const client = { async chat() { return { message: { role: "assistant", content: "No entendí." } }; } };
  const tools = { definitions: () => [], async execute(name, args) {
    executed.push({ name, args });
    return { status: "paused", destination: "Living" };
  } };

  const answer = await new AssistantAgent({ client, tools, log: () => {} }).respond("¡Alto!", { satelliteId: "test" });

  assert.deepEqual(executed, [{ name: "music_pause", args: {} }]);
  assert.equal(answer, "Música pausada en Living.");
});

test("devuelve el error de una tool al LLM para que formule la respuesta", async () => {
  let turn = 0;
  const client = { async chat(messages) {
    turn += 1;
    if (turn === 1) return { message: toolCall("music_play", { query: "Inexistente", mode: "auto" }) };
    assert.match(messages.at(-1).content, /no encontró/i);
    return { message: { role: "assistant", content: "No encontré esa música." } };
  } };
  const tools = { definitions: () => [], async execute() { throw new Error("Music Assistant no encontró el contenido"); } };

  const answer = await new AssistantAgent({ client, tools, log: () => {} }).respond("Pon esa canción", { satelliteId: "test" });

  assert.equal(answer, "No encontré esa música.");
});

test("conserva opciones ambiguas por satélite y reproduce la elegida por URI", async () => {
  const calls = [];
  let firstTurn = true;
  const client = { async chat() {
    if (firstTurn) { firstTurn = false; return { message: toolCall("music_play", { query: "Proyecto J", mode: "artist" }) }; }
    return { message: { role: "assistant", content: "Listo." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    if (calls.length === 1) return { clarificationRequired: true, choices: [
      { name: "Proyecto Jota", uri: "library://artist/1" }, { name: "Proyecto J", uri: "library://artist/2" }
    ], request: { mode: "artist" } };
    return { status: "playing", item: { name: args.query }, destination: "Living" };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  assert.match(await agent.respond("Pon Proyecto J", { satelliteId: "s1" }), /1, Proyecto Jota/);
  assert.match(await agent.respond("la segunda", { satelliteId: "s1" }), /Proyecto J/);
  assert.deepEqual(calls[1], { name: "music_play", args: {
    query: "Proyecto J", mediaUri: "library://artist/2", mode: "artist"
  } });
});

test("el historial se entrega al LLM para resolver confirmaciones sin reglas literales", async () => {
  const seen = [];
  const client = { async chat(messages) { seen.push(messages); return { message: { role: "assistant", content: "Entendido." } }; } };
  const tools = { definitions: () => [], async execute() {} };
  const history = [
    { role: "user", content: "Sube el volumen al cincuenta" },
    { role: "assistant", content: "¿Confirmas?" }
  ];

  await new AssistantAgent({ client, tools, log: () => {} }).respond("Sí, hazlo", { satelliteId: "test", history });

  assert.deepEqual(seen[0].slice(1, 4), [...history, { role: "user", content: "Sí, hazlo" }]);
});
