export const getIdentityTool = {
  definition: {
    type: "function",
    function: {
      name: "assistant_get_identity",
      description: "Obtiene el nombre, propósito y capacidades generales del asistente.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  },

  async execute(args, context) {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
      throw new Error("assistant_get_identity no acepta argumentos");
    }
    return {
      name: context.assistantName,
      purpose: context.assistantPurpose,
      capabilities: [
        "conversar por voz",
        "controlar música y radio mediante herramientas",
        "consultar información como noticias y clima",
        "integrarse en el futuro con automatización del hogar"
      ]
    };
  }
};
