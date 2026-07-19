const minuteMs = 60_000;
const weekdayByName = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(value.hour), minute: Number(value.minute), weekday: weekdayByName[value.weekday] };
}

export function validateRecurrence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recurrence no es válida");
  if (!["daily", "weekly", "interval"].includes(value.frequency)) throw new Error("frequency debe ser daily, weekly o interval");
  const timeZone = String(value.timeZone || "").trim();
  if (!timeZone) throw new Error("La recurrencia requiere timeZone");
  new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
  if (value.frequency === "interval") {
    if (!Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 60 || value.intervalSeconds > 2_592_000) throw new Error("intervalSeconds debe estar entre 60 y 2592000");
    return { frequency: "interval", intervalSeconds: value.intervalSeconds, timeZone };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.localTime || "")) throw new Error("localTime debe tener formato HH:mm");
  const recurrence = { frequency: value.frequency, localTime: value.localTime, timeZone };
  if (value.frequency === "weekly") {
    const weekdays = [...new Set(value.weekdays || [])].sort((a, b) => a - b);
    if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error("weekdays debe contener días ISO del 1 (lunes) al 7 (domingo)");
    recurrence.weekdays = weekdays;
  }
  return recurrence;
}

export function nextOccurrence(recurrence, after) {
  const rule = validateRecurrence(recurrence);
  const reference = after instanceof Date ? after : new Date(after);
  if (Number.isNaN(reference.getTime())) throw new Error("La fecha de referencia no es válida");
  if (rule.frequency === "interval") return new Date(reference.getTime() + rule.intervalSeconds * 1000);

  const [hour, minute] = rule.localTime.split(":").map(Number);
  let candidate = new Date(Math.floor(reference.getTime() / minuteMs) * minuteMs + minuteMs);
  const maximumMinutes = 8 * 24 * 60 + 180;
  for (let index = 0; index < maximumMinutes; index += 1, candidate = new Date(candidate.getTime() + minuteMs)) {
    const local = localParts(candidate, rule.timeZone);
    if (local.hour === hour && local.minute === minute && (rule.frequency === "daily" || rule.weekdays.includes(local.weekday))) return candidate;
  }
  throw new Error("No se pudo calcular la próxima ejecución de la recurrencia");
}
