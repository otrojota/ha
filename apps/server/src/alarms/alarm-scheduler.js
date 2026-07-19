import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nextOccurrence, validateRecurrence } from "./recurrence.js";

const maximumDelayMs = 30 * 24 * 60 * 60 * 1000;

export class AlarmScheduler {
  constructor({ storagePath = null, onFire, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
    this.storagePath = storagePath;
    this.onFire = onFire;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;
    this.alarms = new Map();
    this.persistence = Promise.resolve();
  }

  async start() {
    if (!this.storagePath) return;
    try {
      const stored = JSON.parse(await readFile(this.storagePath, "utf8"));
      if (!Array.isArray(stored.alarms)) throw new Error("El archivo no contiene una lista de alarmas");
      for (const alarm of stored.alarms) {
        if (!this.isStoredAlarmValid(alarm)) {
          this.log("warn", "Alarma persistida inválida ignorada", { alarm });
          continue;
        }
        this.install(alarm, Math.max(0, new Date(alarm.scheduledFor).getTime() - this.now().getTime()));
      }
      this.log("info", "Alarmas restauradas", { count: this.alarms.size, storagePath: this.storagePath });
    } catch (error) {
      if (error.code !== "ENOENT") this.log("warn", "No se pudieron restaurar las alarmas", { error: error.message, storagePath: this.storagePath });
    }
  }

  isStoredAlarmValid(alarm) {
    try {
      return Boolean(alarm
      && typeof alarm.id === "string"
      && typeof alarm.satelliteId === "string"
      && ["alarm", "reminder", "timer", "automation"].includes(alarm.kind)
      && typeof alarm.label === "string"
      && typeof alarm.scheduledFor === "string"
      && !Number.isNaN(Date.parse(alarm.scheduledFor))
      && (!alarm.recurrence || Boolean(validateRecurrence(alarm.recurrence)))
      && (alarm.kind !== "automation" || (Array.isArray(alarm.actions) && alarm.actions.length > 0)));
    } catch {
      return false;
    }
  }

  install(alarm, delayMs) {
    const timer = this.setTimer(() => this.fire(alarm.id), delayMs);
    timer?.unref?.();
    this.alarms.set(alarm.id, { alarm, timer });
  }

  async persist() {
    if (!this.storagePath) return;
    this.persistence = this.persistence.catch(() => {}).then(async () => {
      await mkdir(dirname(this.storagePath), { recursive: true });
      const temporaryPath = `${this.storagePath}.tmp`;
      const alarms = [...this.alarms.values()].map(({ alarm }) => alarm);
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, alarms }, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.storagePath);
    });
    return this.persistence;
  }

  async schedule({ satelliteId, triggerAt, kind = "reminder", label = "", actions = [], announce = false, recurrence = null }) {
    if (!satelliteId) throw new Error("No se pudo identificar el satélite que recibirá el aviso");
    const normalizedRecurrence = recurrence ? validateRecurrence(recurrence) : null;
    const scheduledFor = triggerAt instanceof Date ? triggerAt : new Date(triggerAt);
    if (Number.isNaN(scheduledFor.getTime())) throw new Error("La fecha de la alarma no es válida");
    const delayMs = scheduledFor.getTime() - this.now().getTime();
    if (delayMs < (normalizedRecurrence ? 0 : 1000)) throw new Error("La alarma debe programarse al menos un segundo en el futuro");
    if (delayMs > maximumDelayMs) throw new Error("La alarma no puede programarse a más de 30 días");

    const alarm = {
      id: crypto.randomUUID(),
      satelliteId,
      kind,
      label: String(label || "").trim().slice(0, 160),
      ...(kind === "automation" ? { actions, announce: announce === true } : {}),
      ...(normalizedRecurrence ? { recurrence: normalizedRecurrence } : {}),
      scheduledFor: scheduledFor.toISOString(),
      createdAt: this.now().toISOString()
    };
    this.install(alarm, delayMs);
    await this.persist();
    this.log("info", "Alarma programada", alarm);
    return alarm;
  }

  async fire(id) {
    const scheduled = this.alarms.get(id);
    if (!scheduled) return;
    this.alarms.delete(id);
    this.log("info", "Alarma activada", scheduled.alarm);
    try {
      await this.onFire(scheduled.alarm);
    } catch (error) {
      this.log("warn", "No se pudo emitir la alarma", { id, error: error.message });
    }
    if (scheduled.alarm.recurrence) {
      const next = nextOccurrence(scheduled.alarm.recurrence, this.now());
      scheduled.alarm.scheduledFor = next.toISOString();
      this.install(scheduled.alarm, next.getTime() - this.now().getTime());
      this.log("info", "Alarma recurrente reprogramada", { id, scheduledFor: scheduled.alarm.scheduledFor });
    }
    await this.persist();
  }

  list(satelliteId) {
    return [...this.alarms.values()]
      .map(({ alarm }) => alarm)
      .filter((alarm) => alarm.satelliteId === satelliteId)
      .sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor));
  }

  async cancel({ satelliteId, alarmId, all = false }) {
    const cancelled = [];
    for (const [id, scheduled] of this.alarms) {
      if (scheduled.alarm.satelliteId !== satelliteId) continue;
      if (!all && id !== alarmId) continue;
      this.clearTimer(scheduled.timer);
      this.alarms.delete(id);
      cancelled.push(scheduled.alarm);
    }
    if (cancelled.length) await this.persist();
    this.log("info", "Alarmas canceladas", { satelliteId, count: cancelled.length, alarmId, all });
    return cancelled;
  }

  stop() {
    for (const { timer } of this.alarms.values()) this.clearTimer(timer);
    this.alarms.clear();
  }
}
