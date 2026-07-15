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

test("obliga a consultar Music Assistant para dar detalles de la canción actual", async () => {
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

test("usa el LLM para interpretar un título entre comillas sin agregarlo a la cola", async () => {
  let modelCalls = 0;
  const calls = [];
  const client = { async chat() {
    modelCalls += 1;
    if (modelCalls === 1) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_play", arguments: { query: "Candle in the Wind Elton John", mode: "auto", shuffle: false } } }] } };
    return { message: { role: "assistant", content: "Reproduciendo Candle in the Wind de Elton John." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing", item: { name: "Candle in the Wind" }, destination: "DMP-A6" };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond('quiero escuchar "Candle in the Wind" de Elton John.', {});

  assert.equal(modelCalls, 2);
  assert.deepEqual(calls, [{ name: "music_play", args: { query: "Candle in the Wind Elton John", mode: "auto", shuffle: false } }]);
  assert.equal(answer, "Reproduciendo Candle in the Wind de Elton John.");
});

test("usa el LLM para transformar una solicitud de artista", async () => {
  let modelCalls = 0;
  const calls = [];
  const client = { async chat() {
    modelCalls += 1;
    if (modelCalls === 1) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_play", arguments: { query: "Pink Floyd", mode: "artist", shuffle: true } } }] } };
    return { message: { role: "assistant", content: "Reproduciendo música de Pink Floyd." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing", item: { name: "Pink Floyd" }, destination: "DMP-A6" };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("toca música de Pink Floyd.", {});

  assert.equal(modelCalls, 2);
  assert.deepEqual(calls, [{ name: "music_play", args: { query: "Pink Floyd", mode: "artist", shuffle: true } }]);
  assert.match(answer, /Pink Floyd/);
});

test("autoriza music_play cuando Whisper transcribe toca como tócate y usa el destino activo", async () => {
  const calls = [];
  let turn = 0;
  const client = { async chat() {
    turn += 1;
    if (turn === 1) return { message: { role: "assistant", content: "", tool_calls: [{ function: {
      name: "music_play", arguments: { query: "Proyecto J", mode: "artist" }
    } }] } };
    return { message: { role: "assistant", content: "Reproduciendo Proyecto J en Satélite 1." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing", item: { name: "Proyecto J" }, destination: "Satélite 1" };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  await agent.respond("tócate más de Proyecto J.", {});

  assert.deepEqual(calls, [{ name: "music_play", args: { query: "Proyecto J", mode: "artist" } }]);
});

test("no repite music_play ni agota iteraciones cuando MA rechaza la reproducción", async () => {
  let modelCalls = 0;
  let toolCalls = 0;
  const client = { async chat() {
    modelCalls += 1;
    return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_play", arguments: { query: "Peter Gabriel", mode: "artist" } } }] } };
  } };
  const tools = { definitions: () => [], async execute() {
    toolCalls += 1;
    throw new Error("Player Eversolo is not available");
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("toca algo de Peter Gabriel", {});

  assert.equal(modelCalls, 1);
  assert.equal(toolCalls, 1);
  assert.equal(answer, "No pude iniciar la reproducción: Player Eversolo is not available.");
});

test("deja al LLM convertir criterios musicales complejos en una selección MA", async () => {
  const calls = [];
  let modelCalls = 0;
  const client = { async chat() {
    modelCalls += 1;
    if (modelCalls === 1) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_play", arguments: { query: "So Peter Gabriel", mode: "custom", searches: ["Sledgehammer Peter Gabriel", "Big Time Peter Gabriel", "In Your Eyes Peter Gabriel"], shuffle: false } } }] } };
    return { message: { role: "assistant", content: "Reproduciendo las canciones más conocidas de So, de Peter Gabriel." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) { calls.push({ name, args }); return { status: "playing" }; } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  await agent.respond("Toca las canciones más conocidas del álbum So de Peter Gabriel", {});

  assert.equal(modelCalls, 2);
  assert.equal(calls[0].name, "music_play");
  assert.equal(calls[0].args.mode, "custom");
  assert.deepEqual(calls[0].args.searches, ["Sledgehammer Peter Gabriel", "Big Time Peter Gabriel", "In Your Eyes Peter Gabriel"]);
});

test("una pregunta de lluvia no hereda ni ejecuta acciones del contexto musical", async () => {
  let modelCalls = 0;
  const executed = [];
  const client = { async chat() {
    modelCalls += 1;
    if (modelCalls === 1) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "weather_get_forecast", arguments: { daysFromToday: 1 } } }] } };
    if (modelCalls === 2) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_play", arguments: { query: "Peter Gabriel" } } }] } };
    return { message: { role: "assistant", content: "Mañana se esperan 12 milímetros de lluvia." } };
  } };
  const tools = { definitions: () => [], async execute(name) {
    executed.push(name);
    return { days: [{ precipitationMm: 12 }] };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("¿Cuántos milímetros van a llover mañana?", {
    history: [
      { role: "user", content: "Toca algo de Peter Gabriel" },
      { role: "assistant", content: "Está sonando Red Rain de Peter Gabriel." }
    ]
  });

  assert.deepEqual(executed, ["weather_get_forecast"]);
  assert.match(answer, /12 milímetros/);
});

test("una pregunta genérica no puede repetir efectos laterales del historial", async () => {
  let modelCalls = 0;
  const executed = [];
  const client = { async chat(messages) {
    modelCalls += 1;
    if (modelCalls === 1) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_play", arguments: { query: "Peter Gabriel" } } }] } };
    assert.match(messages.at(-1).content, /no autoriza/);
    return { message: { role: "assistant", content: "París es la capital de Francia." } };
  } };
  const tools = { definitions: () => [], async execute(name) { executed.push(name); return {}; } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("¿Cuál es la capital de Francia?", {
    history: [
      { role: "user", content: "Toca Peter Gabriel" },
      { role: "assistant", content: "Está sonando Red Rain de Peter Gabriel." }
    ]
  });

  assert.deepEqual(executed, []);
  assert.equal(answer, "París es la capital de Francia.");
});

test("una orden actual explícita sí autoriza music_play", async () => {
  let turn = 0;
  const executed = [];
  const client = { async chat() {
    turn += 1;
    if (turn === 1) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_play", arguments: { query: "Pink Floyd", mode: "artist" } } }] } };
    return { message: { role: "assistant", content: "Reproduciendo Pink Floyd." } };
  } };
  const tools = { definitions: () => [], async execute(name) { executed.push(name); return { status: "playing" }; } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  await agent.respond("Toca Pink Floyd", {});

  assert.deepEqual(executed, ["music_play"]);
});

test("una repetición contextual con otro origen exige music_play y sólo confirma su resultado", async () => {
  let turn = 0;
  const calls = [];
  const client = { async chat(messages) {
    turn += 1;
    if (turn === 1) return { message: { role: "assistant", content: "Reproduciendo The World de Pink Floyd desde Spotify." } };
    if (turn === 2) {
      assert.match(messages.at(-1).content, /requiere ejecutar music_play/);
      return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_play", arguments: { query: "The World Pink Floyd", source: "Spotify", mode: "auto" } } }] } };
    }
    assert.match(messages.at(-1).content, /The Wall/);
    return { message: { role: "assistant", content: "Reproduciendo “The Wall” en Parlante Eversolo 2 desde Spotify." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing", item: { name: "The Wall" }, destination: "Parlante Eversolo 2", source: "Spotify" };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("lo mismo que te pedí antes, pero el origen es Spotify.", {
    history: [
      { role: "user", content: "Quiero escuchar el álbum The World de Pink Floyd" },
      { role: "assistant", content: "No pude reproducirlo en Parlante Eversolo 2." }
    ]
  });

  assert.deepEqual(calls, [{ name: "music_play", args: { query: "The World Pink Floyd", source: "Spotify", mode: "auto" } }]);
  assert.equal(answer, "Reproduciendo “The Wall” en Parlante Eversolo 2 desde Spotify.");
});

test("ejecuta music_next si el LLM omite la tool para siguiente canción", async () => {
  const calls = [];
  const client = { async chat() {
    return { message: { role: "assistant", content: "Lo siento, no pude procesar esa solicitud." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing", item: { name: "Time" }, destination: { alias: "Eversolo", name: "DMP-A6" } };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("siguiente canción.", {});

  assert.deepEqual(calls, [{ name: "music_next", args: {} }]);
  assert.equal(answer, "Siguiente canción: “Time” en Eversolo.");
});

for (const phrase of ["Súbelo más.", "Sube lo más."]) {
  test(`interpreta el ajuste contextual de volumen: ${phrase}`, async () => {
    const calls = [];
    const client = { async chat() {
      return { message: { role: "assistant", content: "Lo siento, no pude procesar esa solicitud." } };
    } };
    const tools = { definitions: () => [], async execute(name, args) {
      calls.push({ name, args });
      return { device: { volumePercent: 60 } };
    } };
    const agent = new AssistantAgent({ client, tools, log: () => {} });

    const answer = await agent.respond(phrase, {});

    assert.deepEqual(calls, [{ name: "music_set_volume", args: { changePercent: 10 } }]);
    assert.equal(answer, "Volumen ajustado al 60%.");
  });
}

test("conserva opciones ambiguas por satélite y reproduce la elegida por URI", async () => {
  const calls = [];
  const client = { async chat() {
    return { message: { role: "assistant", content: "", tool_calls: [{ function: {
      name: "music_play", arguments: { query: "Proyecto J", mode: "artist" }
    } }] } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    if (!args.mediaUri) return {
      clarificationRequired: true,
      choices: [
        { name: "Proyecto J", uri: "tidal://artist/project-j", mediaType: "artist" },
        { name: "Proyecto Jota", uri: "tidal://artist/proyecto-jota", mediaType: "artist" }
      ],
      request: { mode: "artist", shuffle: true }
    };
    return { status: "playing", item: { name: args.query }, destination: "Eversolo" };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const question = await agent.respond("toca temas de Proyecto J", { satelliteId: "living" });
  const answer = await agent.respond("el segundo", { satelliteId: "living" });

  assert.match(question, /1, Proyecto J; 2, Proyecto Jota/);
  assert.equal(calls[1].args.mediaUri, "tidal://artist/proyecto-jota");
  assert.equal(answer, "Reproduciendo “Proyecto Jota” en Eversolo.");
});

test("comando anterior no se confunde con music_previous y el LLM reconstruye music_play", async () => {
  let turn = 0;
  const calls = [];
  const client = { async chat() {
    turn += 1;
    if (turn === 1) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_play", arguments: { query: "The Wall Pink Floyd", source: "Spotify", mode: "auto" } } }] } };
    return { message: { role: "assistant", content: "Reproduciendo The Wall de Pink Floyd desde Spotify." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing", item: { name: "In the Flesh?" }, destination: "Eversolo 2", source: "Spotify" };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  await agent.respond('reintenta el comando anterior, pero el álbum es "The Wall".', {
    history: [
      { role: "user", content: "Quiero escuchar el álbum The World de Pink Floyd desde Spotify" },
      { role: "assistant", content: "No pude iniciar la reproducción." }
    ]
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "music_play");
  assert.equal(calls[0].args.query, "The Wall Pink Floyd");
});

test("álbum completo desde el inicio usa music_play en modo album y no una transferencia", async () => {
  let turn = 0;
  const calls = [];
  const client = { async chat() {
    turn += 1;
    if (turn === 1) return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_play", arguments: { query: "The Wall Pink Floyd", source: "Spotify", mode: "album", shuffle: false } } }] } };
    return { message: { role: "assistant", content: "Reproduciendo el álbum The Wall desde el inicio." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing", item: { name: "In the Flesh?" }, destination: "Eversolo 2", source: "Spotify" };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  await agent.respond("Quiero escuchar el álbum completo desde el inicio.", {
    history: [
      { role: "user", content: "Reproduce The Wall de Pink Floyd desde Spotify" },
      { role: "assistant", content: "Está sonando Another Brick in the Wall." }
    ]
  });

  assert.deepEqual(calls, [{ name: "music_play", args: { query: "The Wall Pink Floyd", source: "Spotify", mode: "album", shuffle: false } }]);
});

test("obliga a consultar la cola real de Music Assistant", async () => {
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
    return { status: "playing", destination: { id: "ma:dmp", name: "DMP-A6", room: "Living", active: true } };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("Quiero escuchar en el DMP A6", {});

  assert.equal(modelCalls, 0);
  assert.deepEqual(calls, [{ name: "music_transfer_playback", args: { destination: "DMP A6", play: true } }]);
  assert.match(answer, /reproducción continúa en DMP-A6/);
});

test("transfiere al destino limpio cuando se pide mantener la misma canción", async () => {
  const calls = [];
  let turn = 0;
  const client = { async chat() {
    turn += 1;
    if (turn === 1) return { message: { role: "assistant", content: "", tool_calls: [{ function: {
      name: "music_transfer_playback", arguments: { destination: "Eversolo 2 manteniendo la misma canción", play: true }
    } }] } };
    return { message: { role: "assistant", content: "Transferencia completada." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { destination: { alias: "Eversolo 2" } };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("cambia el destino a Eversolo 2 manteniendo la misma canción.", {});

  assert.deepEqual(calls, [{ name: "music_transfer_playback", args: { destination: "Eversolo 2", play: true } }]);
  assert.equal(answer, "La reproducción continúa en Eversolo 2, que quedó como destino de música activo.");
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
    return { status: "playing", destination: { id: "ma:dmp", name: "DMP-A6", active: true } };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("quiero escuchar en el DMPA6.", {});

  assert.equal(modelCalls, 0);
  assert.deepEqual(calls, [{ name: "music_transfer_playback", args: { destination: "DMPA6", play: true } }]);
  assert.equal(answer, "La reproducción continúa en DMP-A6, que quedó como destino de música activo.");
});

for (const text of ["cambia el parlante al Eversolo 1.", "deja activo el parlante e ver solo uno."]) {
  test(`autoriza cambiar el destino con la orden: ${text}`, async () => {
    const calls = [];
    const client = { async chat() {
      return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_set_active_destination", arguments: { destination: "Eversolo 1" } } }] } };
    } };
    const tools = { definitions: () => [], async execute(name, args) {
      calls.push({ name, args });
      return { id: "ma:eversolo-1", name: "Eversolo 1", room: "Living", active: true };
    } };
    const agent = new AssistantAgent({ client, tools, log: () => {} });

    const answer = await agent.respond(text, {});

    assert.deepEqual(calls, [{ name: "music_set_active_destination", args: { destination: "Eversolo 1" } }]);
    assert.equal(answer, "El destino de música activo es Eversolo 1, en Living.");
  });
}

test("conserva el destino completo pronunciado si el LLM lo trunca", async () => {
  const calls = [];
  const client = { async chat() {
    return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_set_active_destination", arguments: { destination: "hever" } } }] } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { id: "ma:eversolo-1", name: "Eversolo 1", active: true };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  await agent.respond("cambia el parlante al hever solo uno.", {});

  assert.deepEqual(calls, [{ name: "music_set_active_destination", args: { destination: "hever solo uno" } }]);
});

test("combina repetir el mismo álbum con el destino elegido por el LLM", async () => {
  const calls = [];
  const client = { async chat() {
    return { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "music_set_active_destination", arguments: { destination: "Eversolo 2" } } }] } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing", item: { name: "Aforismos" }, destination: "Eversolo 2", source: "Tidal" };
  } };
  const agent = new AssistantAgent({ client, tools, log: () => {} });

  const answer = await agent.respond("reproduce el mismo álbum completo pero en el parlante Eversolo 2.", {
    history: [
      { role: "user", content: "toca el mismo álbum completo pero desde el origen Tidal" },
      { role: "assistant", content: "Reproduciendo “Aforismos” en Eversolo 1 desde Tidal." }
    ]
  });

  assert.deepEqual(calls, [{ name: "music_play", args: { query: "Aforismos", mode: "album", shuffle: false, destination: "Eversolo 2" } }]);
  assert.equal(answer, "Reproduciendo “Aforismos” en Eversolo 2 desde Tidal.");
});
