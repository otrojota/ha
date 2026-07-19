export function createListLibraryRadiosTool({ music, spokenLimit = 20 }) {
  return {
    definition: { type: "function", function: {
      name: "music_list_library_radios",
      description: "Lista las emisoras de radio guardadas en la biblioteca de Music Assistant. Úsala cuando pregunten qué radios o emisoras están disponibles, agregadas o guardadas. No lista orígenes ni proveedores.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    } },
    async execute(args, context = {}) {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
        throw new Error("music_list_library_radios no acepta argumentos");
      }
      const result = await music.getLibraryRadios(context.satelliteId);
      const radios = (result.radios || []).map((radio) => ({
        name: radio.name,
        provider: radio.provider || null,
        uri: radio.uri || null
      }));
      return { total: result.total ?? radios.length, radios: radios.slice(0, spokenLimit), truncated: radios.length > spokenLimit };
    }
  };
}
