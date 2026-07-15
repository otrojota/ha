export const getConfiguredLocationTool = {
  definition: {
    type: "function",
    function: {
      name: "location_get_configured",
      description: "Obtiene la ubicación geográfica configurada del asistente. Debe usarse para saber dónde está, para consultas locales y como ubicación base del clima o pronóstico.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  },
  async execute(args, context) {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new Error("location_get_configured no acepta argumentos");
    if (!context.location) throw new Error("No hay una ubicación configurada");
    return { ...context.location };
  }
};
