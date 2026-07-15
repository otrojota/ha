export function createGetCurrentWeatherTool({ provider }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "weather_get_current",
        description: "Obtiene el clima actual real para las coordenadas configuradas: temperatura, sensación térmica, condición, humedad, precipitación y viento. Debe usarse para cualquier pregunta sobre el clima actual.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    async execute(args, context) {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new Error("weather_get_current no acepta argumentos");
      if (!context.location) throw new Error("No hay una ubicación configurada");
      const weather = await provider.get(context.location);
      return { provider: weather.provider, location: weather.location, fetchedAt: weather.fetchedAt, ...weather.current };
    }
  };
}
