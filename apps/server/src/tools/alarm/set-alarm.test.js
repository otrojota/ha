import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AlarmScheduler } from "../../alarms/alarm-scheduler.js";
import { createCancelAlarmTool } from "./cancel-alarm.tool.js";
import { createListAlarmsTool } from "./list-alarms.tool.js";
import { createGetAlarmRemainingTool } from "./get-alarm-remaining.tool.js";
import { alarmMessage, createSetAlarmTool } from "./set-alarm.tool.js";

const now = new Date("2026-07-14T16:00:00.000Z");

test("programa una cuenta regresiva relativa para el satélite actual", async () => {
  let scheduledDelay;
  let timerCallback;
  const fired = [];
  const scheduler = new AlarmScheduler({
    now: () => now,
    setTimer: (callback, delay) => {
      timerCallback = callback;
      scheduledDelay = delay;
      return { unref() {} };
    },
    clearTimer() {},
    onFire: async (alarm) => fired.push(alarm)
  });
  const tool = createSetAlarmTool({ scheduler });

  const result = await tool.execute({ delaySeconds: 1800, kind: "timer", label: "sacar el pan" }, {
    satelliteId: "cocina",
    timeZone: "America/Santiago",
    now: () => now
  });

  assert.equal(scheduledDelay, 1_800_000);
  assert.equal(result.scheduledFor, "2026-07-14T12:30:00-04:00");
  assert.equal(result.scheduledForUtc, "2026-07-14T16:30:00.000Z");
  assert.equal(result.messageAtFire, "Terminó la cuenta regresiva: sacar el pan.");
  await timerCallback();
  assert.equal(fired[0].satelliteId, "cocina");
});

test("acepta una alarma absoluta sólo cuando incluye zona horaria", async () => {
  const scheduler = new AlarmScheduler({
    now: () => now,
    setTimer: () => ({ unref() {} }),
    clearTimer() {},
    onFire() {}
  });
  const tool = createSetAlarmTool({ scheduler });
  const context = { satelliteId: "living", timeZone: "America/Santiago", now: () => now };

  const result = await tool.execute({ triggerAt: "2026-07-14T13:30:00-04:00", kind: "alarm" }, context);
  assert.equal(result.scheduledFor, "2026-07-14T13:30:00-04:00");
  assert.equal(result.scheduledForUtc, "2026-07-14T17:30:00.000Z");
  await assert.rejects(
    tool.execute({ triggerAt: "2026-07-14T13:30:00", kind: "alarm" }, context),
    /incluir Z o un desfase/
  );
});

test("genera mensajes breves para TTS", () => {
  assert.equal(alarmMessage("timer", ""), "Terminó la cuenta regresiva.");
  assert.equal(alarmMessage("reminder", "regar las plantas"), "Aviso: regar las plantas.");
});

test("persiste y restaura alarmas después de reiniciar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-alarms-"));
  const storagePath = join(directory, "alarms.json");
  try {
    const firstTimers = [];
    const first = new AlarmScheduler({
      storagePath,
      now: () => now,
      setTimer: (callback, delay) => {
        firstTimers.push({ callback, delay });
        return { unref() {} };
      },
      clearTimer() {},
      onFire() {}
    });
    const alarm = await first.schedule({
      satelliteId: "dormitorio",
      triggerAt: new Date("2026-07-14T16:10:00.000Z"),
      kind: "alarm",
      label: "despertar"
    });
    const stored = JSON.parse(await readFile(storagePath, "utf8"));
    assert.equal(stored.alarms[0].id, alarm.id);

    const restoredTimers = [];
    const restored = new AlarmScheduler({
      storagePath,
      now: () => new Date("2026-07-14T16:02:00.000Z"),
      setTimer: (callback, delay) => {
        restoredTimers.push({ callback, delay });
        return { unref() {} };
      },
      clearTimer() {},
      onFire() {}
    });
    await restored.start();

    assert.equal(restoredTimers.length, 1);
    assert.equal(restoredTimers[0].delay, 480_000);
    assert.equal(restored.alarms.get(alarm.id).alarm.satelliteId, "dormitorio");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lista y cancela únicamente alarmas del satélite actual", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-alarms-cancel-"));
  const storagePath = join(directory, "alarms.json");
  const cleared = [];
  try {
    const scheduler = new AlarmScheduler({
      storagePath,
      now: () => now,
      setTimer: () => ({ unref() {} }),
      clearTimer: (timer) => cleared.push(timer),
      onFire() {}
    });
    const livingAlarm = await scheduler.schedule({ satelliteId: "living", triggerAt: new Date("2026-07-14T16:10:00Z"), kind: "timer", label: "té" });
    const kitchenAlarm = await scheduler.schedule({ satelliteId: "cocina", triggerAt: new Date("2026-07-14T16:20:00Z"), kind: "alarm", label: "horno" });
    const listTool = createListAlarmsTool({ scheduler });
    const cancelTool = createCancelAlarmTool({ scheduler });

    const listed = await listTool.execute({}, { satelliteId: "living", timeZone: "America/Santiago" });
    assert.equal(listed.count, 1);
    assert.equal(listed.alarms[0].id, livingAlarm.id);
    assert.equal(listed.alarms[0].scheduledFor, "2026-07-14T12:10:00-04:00");
    assert.equal(listed.alarms[0].scheduledForUtc, "2026-07-14T16:10:00.000Z");
    assert.equal(listed.alarms[0].localTime, "12:10");

    const inaccessible = await cancelTool.execute({ alarmId: kitchenAlarm.id }, { satelliteId: "living" });
    assert.equal(inaccessible.success, false);
    const cancelled = await cancelTool.execute({ alarmId: livingAlarm.id }, { satelliteId: "living" });
    assert.equal(cancelled.cancelledCount, 1);
    assert.equal(scheduler.list("living").length, 0);
    assert.equal(scheduler.list("cocina").length, 1);

    await scheduler.schedule({ satelliteId: "living", triggerAt: new Date("2026-07-14T16:30:00Z"), kind: "reminder", label: "plantas" });
    const cancelledAll = await cancelTool.execute({ all: true }, { satelliteId: "living" });
    assert.equal(cancelledAll.cancelledCount, 1);
    assert.equal(scheduler.list("living").length, 0);

    const stored = JSON.parse(await readFile(storagePath, "utf8"));
    assert.deepEqual(stored.alarms.map((alarm) => alarm.id), [kitchenAlarm.id]);
    assert.equal(cleared.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lista la hora local del aviso y no la hora UTC", async () => {
  const scheduler = {
    list: () => [{ id: "aviso-1", kind: "reminder", label: "prueba", scheduledFor: "2026-07-18T21:11:00.000Z" }]
  };
  const tool = createListAlarmsTool({ scheduler });
  const result = await tool.execute({}, { satelliteId: "living", timeZone: "America/Santiago", locale: "es-CL" });
  assert.equal(result.alarms[0].scheduledFor, "2026-07-18T17:11:00-04:00");
  assert.equal(result.alarms[0].localTime, "17:11");
  assert.equal(result.alarms[0].scheduledForUtc, "2026-07-18T21:11:00.000Z");
});

test("calcula cuánto falta para la próxima alarma y para una etiqueta específica", async () => {
  const scheduler = new AlarmScheduler({
    now: () => now,
    setTimer: () => ({ unref() {} }),
    clearTimer() {},
    onFire() {}
  });
  await scheduler.schedule({ satelliteId: "living", triggerAt: new Date("2026-07-14T16:05:00Z"), kind: "timer", label: "preparar el té" });
  await scheduler.schedule({ satelliteId: "living", triggerAt: new Date("2026-07-14T17:30:00Z"), kind: "reminder", label: "Acostar a Memo" });
  const tool = createGetAlarmRemainingTool({ scheduler });
  const context = { satelliteId: "living", timeZone: "America/Santiago", now: () => now };

  const next = await tool.execute({}, context);
  assert.equal(next.alarms[0].label, "preparar el té");
  assert.equal(next.alarms[0].remainingSeconds, 300);
  assert.equal(next.alarms[0].remainingText, "5 minutos");

  const specific = await tool.execute({ query: "acostar a memo" }, context);
  assert.equal(specific.found, true);
  assert.equal(specific.alarms[0].remainingSeconds, 5400);
  assert.equal(specific.alarms[0].remainingText, "1 hora y 30 minutos");
});

test("una automatización diaria se ejecuta y queda programada para el día siguiente", async () => {
  let current = new Date("2026-07-15T00:00:00.000Z");
  const timers = [];
  const fired = [];
  const scheduler = new AlarmScheduler({
    now: () => current,
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return { unref() {} };
    },
    clearTimer() {},
    onFire: async (alarm) => fired.push(alarm.id)
  });
  const alarm = await scheduler.schedule({
    satelliteId: "living",
    triggerAt: new Date("2026-07-15T00:00:01.000Z"),
    kind: "automation",
    actions: [{ type: "light_turn_on", target: "Luz 1" }],
    recurrence: { frequency: "daily", localTime: "20:00", timeZone: "America/Santiago" }
  });
  current = new Date("2026-07-15T00:00:01.000Z");
  await timers[0].callback();
  assert.deepEqual(fired, [alarm.id]);
  assert.equal(scheduler.list("living")[0].scheduledFor, "2026-07-16T00:00:00.000Z");
  assert.equal(timers.length, 2);
});
