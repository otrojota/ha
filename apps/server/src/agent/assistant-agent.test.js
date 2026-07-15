import assert from "node:assert/strict";
import test from "node:test";
import { AssistantAgent } from "./assistant-agent.js";

test("no permite afirmar una pausa sin ejecutar music_pause", async () => {
  let call = 0;
  const client = {
    async chat(messages) {
      call += 1;
      if (call === 1) return { message: { role: "assistant", content: "La música ha sido pausada." } };
      if (call === 2) {
        assert.match(messages.at(-1).content, /music_pause/);
        return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_pause", arguments: {} } }] } };
      }
      return { message: { role: "assistant", content: "Listo, pausé la música en el DMP-A6." } };
    }
  };
  let executed = false;
  const tools = {
    definitions: () => [],
    async execute(name) { executed = name === "music_pause"; return { status: "paused", destination: "DMP-A6" }; }
  };
  const agent = new AssistantAgent({ client, tools, log: () => {} });
  const answer = await agent.respond("pausa la música", {});
  assert.equal(executed, true);
  assert.match(answer, /Música pausada/);
});

test("interpreta la palabra aislada pausa como music_pause", async () => {
  let turn = 0;
  const executed = [];
  const client = { async chat() {
    turn += 1;
    if (turn === 1) return { message: { role: "assistant", content: "No entendí la solicitud." } };
    if (turn === 2) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_pause", arguments: {} } }] } };
    return { message: { role: "assistant", content: "Música pausada." } };
  } };
  const tools = { definitions: () => [], async execute(name) { executed.push(name); return { status: "paused" }; } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });
  const answer = await agent.respond("pausa", {});
  assert.deepEqual(executed, ["music_pause"]);
  assert.match(answer, /pausada/);
});

test("informa una sola vez si la pausa realmente falla", async () => {
  let modelCalls = 0;
  const client = { async chat() {
    modelCalls += 1;
    return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_pause", arguments: {} } }] } };
  } };
  const tools = { definitions: () => [], async execute() { throw new Error("el dispositivo no admite control remoto"); } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("pausa", {});

  assert.equal(modelCalls, 1);
  assert.match(answer, /No pude pausar/);
  assert.match(answer, /no admite control remoto/);
});

for (const synonym of ["alto", "cállate", "silencio", "detente", "basta", "para", "calla", "corta", "apaga la música"]) {
  test(`interpreta “${synonym}” como music_pause`, async () => {
    let turn = 0;
    const executed = [];
    const client = { async chat() {
      turn += 1;
      if (turn === 1) return { message: { role: "assistant", content: "" } };
      if (turn === 2) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_pause", arguments: {} } }] } };
      return { message: { role: "assistant", content: "Listo." } };
    } };
    const tools = { definitions: () => [], async execute(name) { executed.push(name); return { status: "paused" }; } };
    const agent = new AssistantAgent({ client, tools, log: () => {} });
    await agent.respond(synonym, {});
    assert.deepEqual(executed, ["music_pause"]);
  });
}

test("interpreta un título breve como reproducción dentro de una conversación musical", async () => {
  let call = 0;
  let executed = false;
  const client = {
    async chat() {
      call += 1;
      if (call === 1) return { message: { role: "assistant", content: "Voy a buscarlo en internet." } };
      if (call === 2) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_play", arguments: { query: "Aphorisms de Project J", mode: "auto" } } }] } };
      return { message: { role: "assistant", content: "Reproduciendo el álbum." } };
    }
  };
  const tools = {
    definitions: () => [],
    async execute(name) { executed = name === "music_play"; return { status: "playing" }; }
  };
  const agent = new AssistantAgent({ client, tools, log: () => {} });
  await agent.respond("aforismos de proyecto J", {
    history: [{ role: "assistant", content: "La música está pausada en DMP-A6." }]
  });
  assert.equal(executed, true);
});

test("obliga a consultar Spotify para dar detalles de la canción actual", async () => {
  let turn = 0;
  let executed = false;
  const client = { async chat() {
    turn += 1;
    if (turn === 1) return { message: { role: "assistant", content: "No tengo acceso a esos metadatos." } };
    if (turn === 2) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_get_playback", arguments: {} } }] } };
    return { message: { role: "assistant", content: "Suena Sundown, de Gordon Lightfoot." } };
  } };
  const tools = { definitions: () => [], async execute(name) { executed = name === "music_get_playback"; return { item: { name: "Sundown" } }; } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });
  const answer = await agent.respond("Dame detalles de la canción que suena", {});
  assert.equal(executed, true);
  assert.match(answer, /Sundown/);
});

test("consulta créditos para responder quién canta la canción actual", async () => {
  const executed = [];
  const client = { async chat() { return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_get_current_credits", arguments: {} } }] } }; } };
  const tools = { definitions: () => [], async execute(name) {
    executed.push(name);
    return { title: "Gente Cansada", creditedArtists: ["Proyecto Jota"], vocalists: ["Ana Voz"], performers: [{ name: "Beto Guitarra", role: "guitarra" }], composers: [], lyricists: [], producers: [], engineers: [] };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("¿Quién canta esta canción y quién toca la guitarra?", {});

  assert.deepEqual(executed, ["music_get_current_credits"]);
  assert.match(answer, /Ana Voz/);
  assert.match(answer, /Beto Guitarra/);
});

test("pedir los créditos basta para consultar una sola vez y responder sin bucle", async () => {
  let modelCalls = 0;
  const executed = [];
  const client = { async chat() {
    modelCalls += 1;
    return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_get_current_credits", arguments: {} } }] } };
  } };
  const tools = { definitions: () => [], async execute(name) {
    executed.push(name);
    return {
      title: "Gente Cansada",
      creditedArtists: ["Proyecto Jota"],
      vocalists: [], performers: [], composers: [], lyricists: [], producers: [], engineers: [],
      limitation: "No se encontraron créditos detallados para esta grabación."
    };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("¿Me puedes dar los créditos de esta canción que está sonando?", {});

  assert.equal(modelCalls, 1);
  assert.deepEqual(executed, ["music_get_current_credits"]);
  assert.match(answer, /acreditada a Proyecto Jota/);
  assert.match(answer, /No se encontraron créditos detallados/);
});

test("quién canta tiene prioridad sobre los metadatos básicos de reproducción", async () => {
  const executed = [];
  const client = { async chat() { return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_get_current_credits", arguments: {} } }] } }; } };
  const tools = { definitions: () => [], async execute(name) {
    executed.push(name);
    return { title: "Gente Cansada", creditedArtists: ["Proyecto Jota"], vocalists: ["Ana Voz"], performers: [], composers: [], lyricists: [], producers: [], engineers: [] };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("La canción que está sonando ahora, ¿quién la canta?", {});

  assert.deepEqual(executed, ["music_get_current_credits"]);
  assert.match(answer, /Voz: Ana Voz/);
});

test("cambia una canción inmediatamente y rechaza agregarla a la cola", async () => {
  let turn = 0;
  const executed = [];
  const client = { async chat() {
    turn += 1;
    if (turn === 1) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_add_to_queue", arguments: { query: "Gente Cansada" } } }] } };
    if (turn === 2) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_play", arguments: { query: "Gente Cansada Proyecto J", mode: "auto" } } }] } };
    return { message: { role: "assistant", content: "Ahora suena Gente Cansada, de Proyecto J." } };
  } };
  const tools = { definitions: () => [], async execute(name) { executed.push(name); return { status: "playing" }; } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });
  const answer = await agent.respond("sí, cambia la canción a Gente Cansada", {
    history: [{ role: "assistant", content: "Está sonando música de Proyecto J." }]
  });
  assert.deepEqual(executed, ["music_play"]);
  assert.match(answer, /Gente Cansada/);
});

test("reproduce directamente un título entre comillas sin agregarlo a la cola", async () => {
  let modelCalls = 0;
  const calls = [];
  const client = { async chat() {
    modelCalls += 1;
    return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_add_to_queue", arguments: { query: "Candle in the Wind" } } }] } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing", item: { name: "Candle in the Wind" }, destination: "DMP-A6" };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond('quiero escuchar "Candle in the Wind" de Elton John.', {});

  assert.equal(modelCalls, 0);
  assert.deepEqual(calls, [{ name: "music_play", args: { query: "Candle in the Wind Elton John", mode: "auto", shuffle: false } }]);
  assert.equal(answer, "Reproduciendo “Candle in the Wind” en DMP-A6.");
});

test("obliga a consultar la cola real de Spotify", async () => {
  let turn = 0;
  const executed = [];
  const client = { async chat() {
    turn += 1;
    if (turn === 1) return { message: { role: "assistant", content: "No tengo acceso a la cola." } };
    if (turn === 2) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_get_queue", arguments: {} } }] } };
    return { message: { role: "assistant", content: "Ahora suena A; después vienen B y C." } };
  } };
  const tools = { definitions: () => [], async execute(name) { executed.push(name); return { current: { name: "A" }, queue: [{ name: "B" }, { name: "C" }] }; } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });
  const answer = await agent.respond("muéstrame la cola de reproducción", {});
  assert.deepEqual(executed, ["music_get_queue"]);
  assert.match(answer, /B y C/);
});

test("vacía la cola y responde sin repetir la herramienta", async () => {
  let modelCalls = 0;
  const executed = [];
  const client = { async chat() {
    modelCalls += 1;
    return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_clear_queue", arguments: {} } }] } };
  } };
  const tools = { definitions: () => [], async execute(name) { executed.push(name); return { status: "cleared", cleared: 10, remaining: 0 }; } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("elimina la lista de reproducción", {});

  assert.equal(modelCalls, 1);
  assert.deepEqual(executed, ["music_clear_queue"]);
  assert.equal(answer, "Eliminé 10 canciones de la cola de reproducción.");
});

test("lista una sola vez los dispositivos de música configurados", async () => {
  let modelCalls = 0;
  const executed = [];
  const client = { async chat() {
    modelCalls += 1;
    return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_list_destinations", arguments: {} } }] } };
  } };
  const tools = { definitions: () => [], async execute(name) {
    executed.push(name);
    return {
      activeDestinationId: "dmp",
      destinations: [
        { id: "dmp", name: "Eversolo DMP-A6", alias: "DMP-A6", room: "Living", active: true, available: true },
        { id: "mac", name: "MacBook Pro", alias: null, room: null, active: false, available: false }
      ]
    };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("Muéstrame la lista de dispositivos de música", {});

  assert.equal(modelCalls, 1);
  assert.deepEqual(executed, ["music_list_destinations"]);
  assert.match(answer, /DMP-A6, Living, activo/);
  assert.match(answer, /MacBook Pro, no disponible/);
});

test("interpreta escuchar en DMP A6 como transferencia y selección persistente", async () => {
  let modelCalls = 0;
  const calls = [];
  const client = { async chat() {
    modelCalls += 1;
    return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_set_active_destination", arguments: { destination: "DMP A6" } } }] } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing", destination: { id: "spotify:dmp", name: "DMP-A6", room: "Living", active: true } };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("Quiero escuchar en el DMP A6", {});

  assert.equal(modelCalls, 0);
  assert.deepEqual(calls, [{ name: "music_transfer_playback", args: { destination: "DMP A6", play: true } }]);
  assert.match(answer, /reproducción continúa en DMP-A6/);
});

test("selecciona DMPA6 directamente aunque el modelo intentara listar destinos", async () => {
  let modelCalls = 0;
  const calls = [];
  const client = { async chat() {
    modelCalls += 1;
    return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_list_destinations", arguments: {} } }] } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing", destination: { id: "spotify:dmp", name: "DMP-A6", active: true } };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("quiero escuchar en el DMPA6.", {});

  assert.equal(modelCalls, 0);
  assert.deepEqual(calls, [{ name: "music_transfer_playback", args: { destination: "DMPA6", play: true } }]);
  assert.equal(answer, "La reproducción continúa en DMP-A6, que quedó como destino de música activo.");
});
