import { daysBetween, formatDateInfo } from "./datetime-utils.js";

export const getDateDifferenceTool = {
  definition: {
    type: "function",
    function: {
      name: "datetime_get_date_difference",
      description: "Calcula cuántos días naturales hay entre dos fechas y entrega información local de ambas. Úsala para preguntas como cuánto falta o cuántos días pasaron.",
      parameters: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "Fecha inicial YYYY-MM-DD." },
          end_date: { type: "string", description: "Fecha final YYYY-MM-DD." }
        },
        required: ["start_date", "end_date"],
        additionalProperties: false
      }
    }
  },
  async execute(args, context) {
    if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.start_date !== "string" || typeof args.end_date !== "string") throw new Error("start_date y end_date son obligatorias");
    const differenceDays = daysBetween(args.start_date, args.end_date);
    return {
      start: formatDateInfo(args.start_date, context.locale, context.timeZone),
      end: formatDateInfo(args.end_date, context.locale, context.timeZone),
      differenceDays,
      absoluteDifferenceDays: Math.abs(differenceDays),
      direction: differenceDays === 0 ? "same_day" : differenceDays > 0 ? "future" : "past"
    };
  }
};
