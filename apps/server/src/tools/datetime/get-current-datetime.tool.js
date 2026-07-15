import { currentDateTime } from "./datetime-utils.js";

export const getCurrentDateTimeTool = {
  definition: {
    type: "function",
    function: {
      name: "datetime_get_current",
      description: "Obtiene la fecha y hora actuales, día de la semana, locale, zona horaria y desfase UTC configurados en el servidor. Debe usarse para cualquier pregunta sobre la hora o fecha actual.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  },
  async execute(args, context) {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new Error("datetime_get_current no acepta argumentos");
    return currentDateTime(context.now?.() || new Date(), context.locale, context.timeZone);
  }
};
