export function createGetWeatherForecastTool({ provider }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "weather_get_forecast",
        description: "Obtiene el pronóstico diario para la ubicación configurada. Sirve para consultas de hoy, mañana, una fecha relativa, lluvia, temperaturas máximas/mínimas o próximos días.",
        parameters: {
          type: "object",
          properties: {
            daysFromToday: { type: "integer", minimum: 0, maximum: 7, description: "Día específico: 0 hoy, 1 mañana, hasta 7." },
            numberOfDays: { type: "integer", minimum: 1, maximum: 8, description: "Cantidad de días desde hoy para un pronóstico de varios días." }
          },
          additionalProperties: false
        }
      }
    },
    async execute(args, context) {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Los argumentos de weather_get_forecast no son válidos");
      const hasOffset = Number.isInteger(args.daysFromToday);
      const hasCount = Number.isInteger(args.numberOfDays);
      if (hasOffset === hasCount) throw new Error("Indica exactamente daysFromToday o numberOfDays");
      if (hasOffset && (args.daysFromToday < 0 || args.daysFromToday > 7)) throw new Error("daysFromToday debe estar entre 0 y 7");
      if (hasCount && (args.numberOfDays < 1 || args.numberOfDays > 8)) throw new Error("numberOfDays debe estar entre 1 y 8");
      if (!context.location) throw new Error("No hay una ubicación configurada");
      const weather = await provider.get(context.location);
      const forecast = hasOffset ? weather.daily.slice(args.daysFromToday, args.daysFromToday + 1) : weather.daily.slice(0, args.numberOfDays);
      return { provider: weather.provider, location: weather.location, fetchedAt: weather.fetchedAt, forecast };
    }
  };
}
