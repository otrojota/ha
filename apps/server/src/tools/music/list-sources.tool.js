export function createListMusicSourcesTool({ music }) {
  return {
    definition: { type: "function", function: {
      name: "music_list_sources",
      description: "Lista los orígenes de música configurados y disponibles en Music Assistant. Úsala cuando pregunten de dónde puede obtener música el asistente.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    } },
    async execute(args) {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new Error("music_list_sources no acepta argumentos");
      return music.getSources();
    }
  };
}
