import { nextOccurrence, validateRecurrence } from "../../alarms/recurrence.js";

const absoluteInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const musicTypes = ["music_play", "music_pause", "music_resume", "music_next", "music_previous", "music_set_volume", "music_clear_queue"];
const lightTypes = ["light_turn_on", "light_turn_off", "light_set_brightness", "light_set_color", "light_set_color_temperature"];
const homeTypes = ["home_set_power", "cover_set_open", "climate_set_temperature", "lock_set_locked", "vacuum_set_cleaning"];

function numberInRange(value, minimum, maximum, name) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} debe estar entre ${minimum} y ${maximum}`);
  return value;
}

function requiredBoolean(value, name) {
  if (typeof value !== "boolean") throw new Error(`${name} debe ser booleano`);
  return value;
}

function normalizeAction(action, allowed) {
  if (!action || typeof action !== "object" || Array.isArray(action) || !allowed.has(action.type)) throw new Error(`Acción programada no compatible: ${action?.type || "sin tipo"}`);
  const normalized = { type: action.type };
  if (action.type.startsWith("light_") || homeTypes.includes(action.type)) {
    normalized.target = String(action.target || "").trim();
    if (!normalized.target) throw new Error(`${action.type} requiere target`);
    if (typeof action.room === "string" && action.room.trim()) normalized.room = action.room.trim();
  }
  if (action.type === "light_set_brightness") normalized.brightnessPercent = numberInRange(action.brightnessPercent, 1, 100, "brightnessPercent");
  if (action.type === "light_set_color") {
    normalized.hue = numberInRange(action.hue, 0, 360, "hue");
    normalized.saturationPercent = numberInRange(action.saturationPercent, 0, 100, "saturationPercent");
    normalized.brightnessPercent = numberInRange(action.brightnessPercent, 1, 100, "brightnessPercent");
  }
  if (action.type === "light_set_color_temperature") normalized.temperaturePercent = numberInRange(action.temperaturePercent, 0, 100, "temperaturePercent");
  if (action.type.startsWith("music_")) {
    if (action.type === "music_play") {
      normalized.query = String(action.query || "").trim();
      if (!normalized.query) throw new Error("music_play requiere query");
      normalized.mode = ["auto", "artist", "popular", "album", "similar", "playlist", "custom"].includes(action.mode) ? action.mode : "auto";
      normalized.shuffle = action.mode === "album" ? false : action.mode === "popular" ? action.shuffle === true : action.shuffle !== false;
    }
    for (const key of ["destination", "source"]) if (typeof action[key] === "string" && action[key].trim()) normalized[key] = action[key].trim();
    for (const key of ["volumePercent", "changePercent"]) if (Number.isFinite(action[key])) normalized[key] = action[key];
  }
  if (action.type === "home_set_power") normalized.on = requiredBoolean(action.on, "on");
  if (action.type === "cover_set_open") normalized.open = requiredBoolean(action.open, "open");
  if (action.type === "climate_set_temperature") normalized.temperature = numberInRange(action.temperature, 5, 35, "temperature");
  if (action.type === "lock_set_locked") normalized.locked = requiredBoolean(action.locked, "locked");
  if (action.type === "vacuum_set_cleaning") normalized.cleaning = requiredBoolean(action.cleaning, "cleaning");
  return normalized;
}

export function createScheduleAutomationTool({ scheduler, homeEnabled }) {
  const supportedTypes = [...musicTypes, ...(homeEnabled ? [...lightTypes, ...homeTypes] : [])];
  const allowed = new Set(supportedTypes);
  return {
    definition: { type: "function", function: {
      name: "automation_schedule",
      description: "Programa acciones futuras, únicas o recurrentes usando las mismas acciones permitidas de Music Assistant y Home Assistant. Úsala también cuando el usuario diga recuérdame o avísame y pida ejecutar una acción. Usa una llamada por horario; announce=true sólo si además quiere oír un aviso.",
      parameters: { type: "object", properties: {
        delaySeconds: { type: "integer", minimum: 1, maximum: 2592000 },
        triggerAt: { type: "string", description: "Instante ISO 8601 completo con zona" },
        recurrence: { type: "object", properties: {
          frequency: { type: "string", enum: ["daily", "weekly", "interval"] },
          localTime: { type: "string", description: "Hora local HH:mm para daily o weekly" },
          weekdays: { type: "array", items: { type: "integer", minimum: 1, maximum: 7 }, description: "Días ISO: lunes=1, domingo=7" },
          intervalSeconds: { type: "integer", minimum: 60, maximum: 2592000 }
        }, required: ["frequency"], additionalProperties: false },
        label: { type: "string", maxLength: 160 },
        announce: { type: "boolean", description: "Lee una confirmación al ejecutarse sólo si el usuario pidió también un aviso" },
        actions: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", properties: {
          type: { type: "string", enum: supportedTypes }, target: { type: "string" }, room: { type: "string" },
          brightnessPercent: { type: "number", minimum: 1, maximum: 100 }, hue: { type: "number", minimum: 0, maximum: 360 },
          saturationPercent: { type: "number", minimum: 0, maximum: 100 }, temperaturePercent: { type: "number", minimum: 0, maximum: 100 },
          query: { type: "string" }, mode: { type: "string", enum: ["auto", "artist", "popular", "album", "similar", "playlist", "custom"] },
          destination: { type: "string" }, source: { type: "string" }, shuffle: { type: "boolean" },
          volumePercent: { type: "number", minimum: 0, maximum: 100 }, changePercent: { type: "number", minimum: -100, maximum: 100 },
          on: { type: "boolean" }, open: { type: "boolean" }, temperature: { type: "number", minimum: 5, maximum: 35 },
          locked: { type: "boolean" }, cleaning: { type: "boolean" }
        }, required: ["type"], additionalProperties: false } }
      }, required: ["actions"], additionalProperties: false }
    } },
    async execute(args, context) {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Los argumentos de automation_schedule no son válidos");
      const hasDelay = Number.isInteger(args.delaySeconds);
      const hasTrigger = typeof args.triggerAt === "string" && args.triggerAt.length > 0;
      const hasRecurrence = args.recurrence !== undefined;
      if (Number(hasDelay) + Number(hasTrigger) + Number(hasRecurrence) !== 1) throw new Error("Indica exactamente uno entre delaySeconds, triggerAt y recurrence");
      if (hasTrigger && !absoluteInstantPattern.test(args.triggerAt)) throw new Error("triggerAt debe ser ISO 8601 e incluir zona horaria");
      if (hasDelay && (args.delaySeconds < 1 || args.delaySeconds > 2_592_000)) throw new Error("delaySeconds no es válido");
      if (!Array.isArray(args.actions) || !args.actions.length || args.actions.length > 10) throw new Error("actions debe contener entre 1 y 10 acciones");
      if (!context.satelliteId) throw new Error("No hay un satélite asociado a la automatización");
      const actions = args.actions.map((action) => normalizeAction(action, allowed));
      const now = context.now?.() || new Date();
      const recurrence = hasRecurrence ? validateRecurrence({ ...args.recurrence, timeZone: context.timeZone }) : null;
      const triggerAt = recurrence ? nextOccurrence(recurrence, now) : hasDelay ? new Date(now.getTime() + args.delaySeconds * 1000) : new Date(args.triggerAt);
      const automation = await scheduler.schedule({ satelliteId: context.satelliteId, triggerAt, kind: "automation", label: args.label, actions, announce: args.announce, recurrence });
      return { success: true, id: automation.id, scheduledFor: automation.scheduledFor, recurrence: automation.recurrence || null, actionCount: actions.length, actions, announce: automation.announce };
    }
  };
}
