export function createListMusicDestinationsTool({ music }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "music_list_destinations",
        description: "Lista los destinos de música que el usuario agregó e indica cuál está activo. Úsala si necesitas conocer nombres disponibles o el destino actual.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    async execute(args) {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new Error("music_list_destinations no acepta argumentos");
      const state = await music.getDestinations();
      return {
        activeDestinationId: state.activeDestinationId,
        destinations: state.destinations.filter((item) => item.enabled !== false).map((item) => ({
          id: item.id, name: item.name, alias: item.alias, room: item.room, active: item.active, available: item.available, source: item.source
        }))
      };
    }
  };
}
