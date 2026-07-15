export function createCancelAlarmTool({ scheduler }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "alarm_cancel",
        description: "Cancela una alarma concreta por su ID o todas las alarmas del satélite actual. Si el usuario identifica una alarma por hora o descripción, llama primero a alarm_list y utiliza el ID devuelto. No inventes IDs.",
        parameters: {
          type: "object",
          properties: {
            alarmId: { type: "string", description: "ID exacto obtenido mediante alarm_list." },
            all: { type: "boolean", description: "Debe ser true sólo si el usuario pidió eliminar todas las alarmas." }
          },
          additionalProperties: false
        }
      }
    },
    async execute(args, context) {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Los argumentos de alarm_cancel no son válidos");
      if (!context.satelliteId) throw new Error("No hay un satélite de destino");
      const alarmId = typeof args.alarmId === "string" ? args.alarmId.trim() : "";
      const all = args.all === true;
      if (Boolean(alarmId) === all) throw new Error("Indica exactamente alarmId o all=true");
      const cancelled = await scheduler.cancel({ satelliteId: context.satelliteId, alarmId, all });
      if (!cancelled.length) return { success: false, cancelledCount: 0, reason: "No se encontró una alarma activa con ese criterio" };
      return {
        success: true,
        cancelledCount: cancelled.length,
        cancelled: cancelled.map((alarm) => ({ id: alarm.id, kind: alarm.kind, label: alarm.label, scheduledFor: alarm.scheduledFor }))
      };
    }
  };
}
