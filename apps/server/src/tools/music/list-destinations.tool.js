export function createListMusicDestinationsTool({ music }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "music_list_destinations",
        description: "Lista todos los reproductores habilitados que Music Assistant expone como destinos e indica cuál está activo.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    async execute(args, context = {}) {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new Error("music_list_destinations no acepta argumentos");
      const state = await music.getDestinations(context.satelliteId);
      return {
        activeDestinationId: state.activeDestinationId,
        destinations: state.destinations.filter((item) => item.enabled !== false).map((item) => ({
          id: item.id, name: item.name, active: item.active, available: item.available, provider: item.provider
        }))
      };
    }
  };
}
