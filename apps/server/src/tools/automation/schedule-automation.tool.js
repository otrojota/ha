import { nextOccurrence, validateRecurrence } from "../../alarms/recurrence.js";

const absoluteInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const musicTypes = ["music_play", "music_pause", "music_resume"];
const lightTypes = ["light_turn_on", "light_turn_off", "light_set_brightness", "light_set_color", "light_set_color_temperature"];

function numberInRange(value, minimum, maximum, name) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} debe estar entre ${minimum} y ${maximum}`);
  return value;
}

function normalizeAction(action, allowed) {
  if (!action || typeof action !== "object" || Array.isArray(action) || !allowed.has(action.type)) throw new Error(`Acción programada no compatible: ${action?.type || "sin tipo"}`);
  const normalized = { type: action.type };
  if (action.type.startsWith("light_")) {
    normalized.target = String(action.target || "").trim();
    if (!normalized.target) throw new Error(`${action.type} requiere target`);
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
      normalized.mode = ["auto", "artist", "album", "similar", "playlist", "custom"].includes(action.mode) ? action.mode : "auto";
      normalized.shuffle = action.mode === "album" ? false : action.shuffle !== false;
    }
    for (const key of ["destination", "source"]) if (typeof action[key] === "string" && action[key].trim()) normalized[key] = action[key].trim();
  }
  return normalized;
}

export function createScheduleAutomationTool({ scheduler, homeEnabled }) {
  const supportedTypes = [...musicTypes, ...(homeEnabled ? lightTypes : [])];
  const allowed = new Set(supportedTypes);
  return {
    definition: { type: "function", function: {
      name: "automation_schedule",
      description: "Programa acciones futuras, únicas o recurrentes, sobre Music Assistant y luces de Home Assistant. Usa una llamada por horario: si encender y apagar ocurren a horas distintas, llama dos veces. Para todos los días usa recurrence frequency=daily; para días específicos weekly; para cada cierto intervalo interval.",
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
          type: { type: "string", enum: supportedTypes }, target: { type: "string" },
          brightnessPercent: { type: "number", minimum: 1, maximum: 100 }, hue: { type: "number", minimum: 0, maximum: 360 },
          saturationPercent: { type: "number", minimum: 0, maximum: 100 }, temperaturePercent: { type: "number", minimum: 0, maximum: 100 },
          query: { type: "string" }, mode: { type: "string", enum: ["auto", "artist", "album", "similar", "playlist", "custom"] },
          destination: { type: "string" }, source: { type: "string" }, shuffle: { type: "boolean" }
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
