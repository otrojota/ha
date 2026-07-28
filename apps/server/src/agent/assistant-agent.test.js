import assert from "node:assert/strict";
import test from "node:test";
import { AssistantAgent } from "./assistant-agent.js";

function toolCall(name, args) {
  return { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] };
}

function toolCalls(calls) {
  return {
    role: "assistant",
    content: "",
    tool_calls: calls.map(({ name, args }) => ({ function: { name, arguments: args } }))
  };
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

test("informa directamente cuando el parlante aún no fue descubierto al ajustar volumen", async () => {
  const client = { async chat() {
    return { message: toolCall("music_set_volume", { changePercent: 10 }) };
  } };
  const tools = {
    definitions: () => [],
    async execute() {
      throw new Error("El parlante aún no ha sido descubierto por el servidor. Espera unos minutos y vuelve a intentarlo");
    }
  };

  const answer = await new AssistantAgent({ client, tools, log: () => {} })
    .respond("Sube el volumen", { satelliteId: "rpi" });

  assert.equal(answer, "El parlante aún no ha sido descubierto por el servidor. Espera unos minutos y vuelve a intentarlo.");
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

test("reproduce un artista en el destino pedido sin transferir la cola anterior", async () => {
  let turn = 0;
  const calls = [];
  const request = { query: "Pink Floyd", destination: "Satellite 1", mode: "artist" };
  const client = { async chat(messages) {
    turn += 1;
    if (turn === 1) return { message: toolCall("music_transfer_playback", { destination: "Satellite 1", play: true }) };
    if (turn === 2) {
      assert.match(messages.at(-1).content, /requiere music_play; no ejecutes music_transfer_playback/);
      return { message: toolCall("music_play", request) };
    }
    return { message: { role: "assistant", content: "Reproduciendo Pink Floyd en Satellite 1." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing", item: { name: "Pink Floyd" }, destination: "Satellite 1" };
  } };

  await new AssistantAgent({ client, tools, log: () => {} })
    .respond("quiero escuchar música de Pink Floyd en el satélite 1", { satelliteId: "dev-satellite-1" });

  assert.deepEqual(calls, [{ name: "music_play", args: request }]);
});

test("transfiere solamente cuando el pedido se refiere a la reproducción actual", async () => {
  let turn = 0;
  const calls = [];
  const client = { async chat() {
    turn += 1;
    return { message: turn === 1
      ? toolCall("music_transfer_playback", { destination: "Satellite 1", play: true })
      : { role: "assistant", content: "He transferido la reproducción." } };
  } };
  const tools = { definitions: () => [], async execute(name, args) {
    calls.push({ name, args });
    return { status: "playing" };
  } };

  await new AssistantAgent({ client, tools, log: () => {} })
    .respond("quiero escuchar esta música en el Satellite 1", { satelliteId: "dev-satellite-1" });

  assert.deepEqual(calls, [{ name: "music_transfer_playback", args: { destination: "Satellite 1", play: true } }]);
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
      assert.match(messages.at(-1).content, /No ejecutaste music_next/);
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

test("rechaza consultar la cola cuando el usuario ordenó avanzar y exige music_next", async () => {
  let turn = 0;
  const calls = [];
  const client = { async chat(messages) {
    turn += 1;
    if (turn === 1) return { message: toolCall("music_get_queue", {}) };
    if (turn === 2) {
      assert.match(messages.at(-1).content, /requiere music_next; no ejecutes music_get_queue/);
      return { message: toolCall("music_next", {}) };
    }
    return { message: { role: "assistant", content: "Siguiente canción: Mala." } };
  } };
  const tools = { definitions: () => [], async execute(name) {
    calls.push(name);
    return { item: { name: "Mala" } };
  } };

  const answer = await new AssistantAgent({ client, tools, log: () => {} })
    .respond("Siguiente canción", { satelliteId: "rpi" });

  assert.deepEqual(calls, ["music_next"]);
  assert.equal(answer, "Siguiente canción: Mala.");
});

test("marca como silenciosas las acciones que inician o cambian la pista", async () => {
  for (const [command, tool] of [["Pon una canción", "music_play"], ["Siguiente canción", "music_next"], ["Canción anterior", "music_previous"]]) {
    let turn = 0;
    let suppressed = false;
    const client = { async chat() {
      turn += 1;
      return { message: turn === 1 ? toolCall(tool, tool === "music_play" ? { query: "Canción" } : {})
        : { role: "assistant", content: "Acción realizada." } };
    } };
    const tools = { definitions: () => [], async execute() { return { item: { name: "Canción" } }; } };

    await new AssistantAgent({ client, tools, log: () => {} }).respond(command, {
      satelliteId: "rpi", suppressSpeech: () => { suppressed = true; }
    });

    assert.equal(suppressed, true, tool);
  }
});

test("mantiene TTS para consultas y controles que no cambian la pista", async () => {
  let turn = 0;
  let suppressed = false;
  const client = { async chat() {
    turn += 1;
    return { message: turn === 1 ? toolCall("music_pause", {}) : { role: "assistant", content: "Música pausada." } };
  } };
  const tools = { definitions: () => [], async execute() { return { status: "paused" }; } };

  await new AssistantAgent({ client, tools, log: () => {} }).respond("Pausa la música", {
    satelliteId: "rpi", suppressSpeech: () => { suppressed = true; }
  });

  assert.equal(suppressed, false);
});

test("interpreta encender y apagar la música como reanudar y pausar", async () => {
  for (const [command, expectedTool] of [["Enciende la música", "music_resume"], ["Prende la reproducción", "music_resume"], ["Apaga la música", "music_pause"]]) {
    let turn = 0;
    const calls = [];
    const client = { async chat() {
      turn += 1;
      return { message: turn === 1 ? toolCall(expectedTool, {}) : { role: "assistant", content: "Listo." } };
    } };
    const tools = { definitions: () => [], async execute(name) { calls.push(name); return { status: "ok" }; } };

    await new AssistantAgent({ client, tools, log: () => {} }).respond(command, { satelliteId: "rpi" });

    assert.deepEqual(calls, [expectedTool], command);
  }
});

test("exige consultar la biblioteca cuando preguntan por playlists disponibles", async () => {
  let turn = 0;
  const calls = [];
  const client = { async chat(messages) {
    turn += 1;
    if (turn === 1) return { message: toolCall("music_list_sources", {}) };
    if (turn === 2) {
      assert.match(messages.at(-1).content, /requiere music_list_library_playlists/);
      return { message: toolCall("music_list_library_playlists", {}) };
    }
    return { message: { role: "assistant", content: "Tienes Favoritas y Viaje." } };
  } };
  const tools = {
    definitions: () => [],
    async execute(name) {
      calls.push(name);
      return { total: 2, playlists: [{ name: "Favoritas" }, { name: "Viaje" }] };
    }
  };

  const answer = await new AssistantAgent({ client, tools, log: () => {} })
    .respond("¿Qué listas de reproducción tengo disponibles?", { satelliteId: "rpi" });

  assert.deepEqual(calls, ["music_list_library_playlists"]);
  assert.equal(answer, "Tienes Favoritas y Viaje.");
});

test("una acción futura de Home Assistant no puede degradarse a un recordatorio", async () => {
  let turn = 0;
  const calls = [];
  const scheduled = {
    delaySeconds: 10,
    actions: [{ type: "home_set_power", target: "enchufe Memo", on: true }]
  };
  const client = { async chat(messages) {
    turn += 1;
    if (turn === 1) return { message: toolCalls([
      { name: "home_set_power", args: { target: "enchufe Memo", on: false } },
      { name: "alarm_set", args: { delaySeconds: 10, kind: "reminder", label: "encender enchufe Memo" } }
    ]) };
    if (turn === 2) {
      assert.match(messages.at(-1).content, /requiere automation_schedule.*alarm_set sólo crea un aviso/);
      return { message: toolCall("automation_schedule", scheduled) };
    }
    return { message: { role: "assistant", content: "Apagué el enchufe y programé que vuelva a encenderse." } };
  } };
  const tools = {
    definitions: () => [
      { function: { name: "home_list_devices" } },
      { function: { name: "automation_schedule" } }
    ],
    async execute(name, args) {
      calls.push({ name, args });
      return { status: "ok" };
    }
  };

  await new AssistantAgent({ client, tools, log: () => {} })
    .respond("Apaga el enchufe Memo y vuelve a encenderlo en 10 segundos.", { satelliteId: "dev-satellite-1" });

  assert.deepEqual(calls, [
    { name: "home_set_power", args: { target: "enchufe Memo", on: false } },
    { name: "automation_schedule", args: scheduled }
  ]);
});

test("apágate controla exclusivamente el enchufe asociado al satélite", async () => {
  let turn = 0;
  const calls = [];
  const client = { async chat(messages) {
    turn += 1;
    assert.match(messages[0].content, /switch\.enchufe_memo/);
    return { message: turn === 1
      ? toolCall("home_set_power", { target: "switch.enchufe_memo", on: false })
      : { role: "assistant", content: "Apagando este satélite." } };
  } };
  const tools = {
    definitions: () => [{ function: { name: "home_list_devices" } }],
    async execute(name, args) { calls.push({ name, args }); return { status: "ok" }; }
  };

  await new AssistantAgent({ client, tools, log: () => {} }).respond("Apágate", {
    satelliteId: "memo", connectedPowerDeviceId: "switch.enchufe_memo"
  });

  assert.deepEqual(calls, [{
    name: "home_set_power", args: { target: "switch.enchufe_memo", on: false }
  }]);
});

test("apágate en media hora programa el enchufe asociado sin apagarlo inmediatamente", async () => {
  let turn = 0;
  const calls = [];
  const scheduled = {
    delaySeconds: 1800,
    actions: [{ type: "home_set_power", target: "switch.enchufe_memo", on: false }]
  };
  const client = { async chat() {
    turn += 1;
    return { message: turn === 1
      ? toolCall("automation_schedule", scheduled)
      : { role: "assistant", content: "Programé el apagado en media hora." } };
  } };
  const tools = {
    definitions: () => [
      { function: { name: "home_list_devices" } },
      { function: { name: "automation_schedule" } }
    ],
    async execute(name, args) { calls.push({ name, args }); return { status: "scheduled" }; }
  };

  await new AssistantAgent({ client, tools, log: () => {} }).respond("Apágate en media hora", {
    satelliteId: "memo", connectedPowerDeviceId: "switch.enchufe_memo"
  });

  assert.deepEqual(calls, [{ name: "automation_schedule", args: scheduled }]);
});

test("apágate a una hora concreta consulta el tiempo y programa el enchufe asociado", async () => {
  let turn = 0;
  const calls = [];
  const scheduled = {
    triggerAt: "2026-07-23T23:55:00-04:00",
    actions: [{ type: "home_set_power", target: "switch.enchufe_memo", on: false }]
  };
  const client = { async chat() {
    turn += 1;
    if (turn === 1) return { message: toolCall("datetime_get_current", {}) };
    if (turn === 2) return { message: toolCall("automation_schedule", scheduled) };
    return { message: { role: "assistant", content: "Programé el apagado para las 23:55." } };
  } };
  const tools = {
    definitions: () => [
      { function: { name: "home_list_devices" } },
      { function: { name: "automation_schedule" } }
    ],
    async execute(name, args) {
      calls.push({ name, args });
      return name === "datetime_get_current"
        ? { iso: "2026-07-23T19:30:00-04:00" }
        : { status: "scheduled" };
    }
  };

  await new AssistantAgent({ client, tools, log: () => {} }).respond("Apágate a las 23:55", {
    satelliteId: "memo", connectedPowerDeviceId: "switch.enchufe_memo"
  });

  assert.deepEqual(calls, [
    { name: "datetime_get_current", args: {} },
    { name: "automation_schedule", args: scheduled }
  ]);
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

test("tolera que STT transcriba pausa como pauza aun con contexto musical", async () => {
  let turn = 0;
  const executed = [];
  const client = { async chat() {
    turn += 1;
    return { message: turn === 1
      ? toolCall("music_pause", {})
      : { role: "assistant", content: "Música pausada." } };
  } };
  const tools = {
    definitions: () => [],
    async execute(name, args) {
      executed.push({ name, args });
      return { status: "paused", destination: "simón" };
    }
  };

  const answer = await new AssistantAgent({ client, tools, log: () => {} }).respond("Pauza.", {
    satelliteId: "memo",
    history: [
      { role: "user", content: "Pon música" },
      { role: "assistant", content: "Reproduciendo música." }
    ]
  });

  assert.deepEqual(executed, [{ name: "music_pause", args: {} }]);
  assert.equal(answer, "Música pausada.");
});

test("deja que MA resuelva un control sobre reproducción manual aunque la frase sea imprecisa", async () => {
  let turn = 0;
  const executed = [];
  const client = { async chat() {
    turn += 1;
    return { message: turn === 1
      ? toolCall("music_pause", {})
      : { role: "assistant", content: "Música pausada." } };
  } };
  const tools = {
    definitions: () => [],
    async execute(name, args) {
      executed.push({ name, args });
      return { status: "paused", destination: "simón" };
    }
  };

  await new AssistantAgent({ client, tools, log: () => {} }).respond("Frena eso.", {
    satelliteId: "memo",
    history: [
      { role: "user", content: "¿Qué está sonando?" },
      { role: "assistant", content: "Está sonando una canción en simón." }
    ]
  });

  assert.deepEqual(executed, [{ name: "music_pause", args: {} }]);
});

test("mantiene la guarda cuando una orden explícita de reproducir intenta pausar", async () => {
  let turn = 0;
  const client = { async chat(messages) {
    turn += 1;
    if (turn === 1) return { message: toolCall("music_pause", {}) };
    if (turn === 2) {
      assert.match(messages.at(-1).content, /requiere music_play; no ejecutes music_pause/);
      return { message: toolCall("music_play", { query: "música", mode: "auto" }) };
    }
    return { message: { role: "assistant", content: "Reproduciendo." } };
  } };
  const executed = [];
  const tools = {
    definitions: () => [],
    async execute(name, args) {
      executed.push({ name, args });
      return { status: "playing" };
    }
  };

  await new AssistantAgent({ client, tools, log: () => {} }).respond("Pon música", { satelliteId: "memo" });

  assert.deepEqual(executed, [{ name: "music_play", args: { query: "música", mode: "auto" } }]);
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
