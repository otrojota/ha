export function createListAlarmsTool({ scheduler }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "alarm_list",
        description: "Lista las alarmas, avisos y cuentas regresivas activas del satélite actual. Úsala también antes de cancelar por hora, tipo o descripción para obtener el ID exacto.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    async execute(args, context) {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new Error("alarm_list no acepta argumentos");
      if (!context.satelliteId) throw new Error("No hay un satélite de destino");
      const alarms = scheduler.list(context.satelliteId).map((alarm) => ({
        id: alarm.id,
        kind: alarm.kind,
        label: alarm.label,
        scheduledFor: alarm.scheduledFor
      }));
      return { count: alarms.length, timeZone: context.timeZone, alarms };
    }
  };
}
