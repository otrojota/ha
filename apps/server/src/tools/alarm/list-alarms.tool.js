import { alarmLocalTime } from "./alarm-time.js";

export function createListAlarmsTool({ scheduler }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "alarm_list",
        description: "Lista las alarmas, avisos, cuentas regresivas y automatizaciones programadas del satélite actual. Úsala también antes de cancelar por hora, tipo o descripción para obtener el ID exacto.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    async execute(args, context) {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new Error("alarm_list no acepta argumentos");
      if (!context.satelliteId) throw new Error("No hay un satélite de destino");
      const alarms = scheduler.list(context.satelliteId).map((alarm) => {
        const local = alarmLocalTime(alarm.scheduledFor, context.timeZone, context.locale);
        return {
          id: alarm.id,
          kind: alarm.kind,
          label: alarm.label,
          ...local,
          ...(alarm.recurrence ? { recurrence: alarm.recurrence } : {}),
          ...(alarm.kind === "automation" ? { actions: alarm.actions, announce: alarm.announce === true } : {})
        };
      });
      return { count: alarms.length, timeZone: context.timeZone, alarms };
    }
  };
}
