import { alarmLocalTime } from "./alarm-time.js";

const absoluteInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function alarmMessage(kind, label) {
  if (label) return kind === "timer" ? `Terminó la cuenta regresiva: ${label}.` : `Aviso: ${label}.`;
  return kind === "timer" ? "Terminó la cuenta regresiva." : "Es la hora de tu alarma.";
}

export function createSetAlarmTool({ scheduler }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "alarm_set",
        description: "Programa una alarma, un aviso futuro o una cuenta regresiva para el satélite actual. Usa delaySeconds para duraciones relativas como 'en 30 minutos'; usa triggerAt para una fecha u hora concreta. Debe llamarse siempre que el usuario pida avisar, alarmar, temporizar o iniciar una cuenta regresiva.",
        parameters: {
          type: "object",
          properties: {
            delaySeconds: {
              type: "integer",
              minimum: 1,
              maximum: 2592000,
              description: "Segundos desde ahora. Úsalo para expresiones relativas y cuentas regresivas."
            },
            triggerAt: {
              type: "string",
              description: "Instante absoluto ISO 8601 con zona, por ejemplo 2026-07-14T18:30:00-04:00. Para calcularlo usa antes datetime_get_current."
            },
            kind: {
              type: "string",
              enum: ["alarm", "reminder", "timer"],
              description: "Tipo de aviso solicitado."
            },
            label: {
              type: "string",
              maxLength: 160,
              description: "Motivo breve que se leerá al vencer. Déjalo vacío si el usuario no indicó uno."
            }
          },
          required: ["kind"],
          additionalProperties: false
        }
      }
    },
    async execute(args, context) {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Los argumentos de alarm_set no son válidos");
      if (!new Set(["alarm", "reminder", "timer"]).has(args.kind)) throw new Error("kind debe ser alarm, reminder o timer");
      if (args.label !== undefined && typeof args.label !== "string") throw new Error("label debe ser texto");
      if (typeof args.label === "string" && args.label.length > 160) throw new Error("label no puede superar 160 caracteres");
      const hasDelay = Number.isInteger(args.delaySeconds);
      const hasTrigger = typeof args.triggerAt === "string" && args.triggerAt.length > 0;
      if (hasDelay === hasTrigger) throw new Error("Indica exactamente uno entre delaySeconds y triggerAt");
      if (!hasDelay && !absoluteInstantPattern.test(args.triggerAt)) throw new Error("triggerAt debe ser ISO 8601 e incluir Z o un desfase horario");
      if (hasDelay && (args.delaySeconds < 1 || args.delaySeconds > 2_592_000)) throw new Error("delaySeconds debe estar entre 1 y 2592000");
      if (!context.satelliteId) throw new Error("No hay un satélite de destino para la alarma");

      const now = context.now?.() || new Date();
      const triggerAt = hasDelay ? new Date(now.getTime() + args.delaySeconds * 1000) : new Date(args.triggerAt);
      const alarm = await scheduler.schedule({
        satelliteId: context.satelliteId,
        triggerAt,
        kind: args.kind,
        label: args.label
      });
      const local = alarmLocalTime(alarm.scheduledFor, context.timeZone, context.locale);
      return {
        success: true,
        id: alarm.id,
        kind: alarm.kind,
        ...local,
        messageAtFire: alarmMessage(alarm.kind, alarm.label)
      };
    }
  };
}

export { alarmMessage };
