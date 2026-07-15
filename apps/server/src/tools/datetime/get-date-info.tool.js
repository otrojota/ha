import { addCalendarDays, formatDateInfo, localDateAt } from "./datetime-utils.js";

export const getDateInfoTool = {
  definition: {
    type: "function",
    function: {
      name: "datetime_get_date_info",
      description: "Obtiene el día de la semana y formatos locales de una fecha. Usa date para una fecha YYYY-MM-DD, o days_from_today para ayer, mañana y fechas relativas.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Fecha exacta en formato YYYY-MM-DD." },
          days_from_today: { type: "integer", minimum: -36500, maximum: 36500, description: "Desplazamiento desde hoy: -1 ayer, 0 hoy, 1 mañana." }
        },
        additionalProperties: false
      }
    }
  },
  async execute(args, context) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Argumentos inválidos");
    const hasDate = typeof args.date === "string";
    const hasOffset = Number.isInteger(args.days_from_today);
    if (hasDate === hasOffset) throw new Error("Indica exactamente date o days_from_today");
    if (hasOffset && Math.abs(args.days_from_today) > 36500) throw new Error("days_from_today está fuera del rango permitido");
    const today = localDateAt(context.now?.() || new Date(), context.locale, context.timeZone);
    const date = hasDate ? args.date : addCalendarDays(today, args.days_from_today);
    return { ...formatDateInfo(date, context.locale, context.timeZone), relativeToTodayDays: hasDate ? null : args.days_from_today, locale: context.locale, timeZone: context.timeZone };
  }
};
