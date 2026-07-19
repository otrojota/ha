export function createSetActiveMusicDestinationTool({ music }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "music_set_active_destination",
        description: "Cambia sólo el destino predeterminado de este satélite para las próximas acciones. No mueve ninguna reproducción existente; para moverla usa music_transfer_playback.",
        parameters: {
          type: "object",
          properties: { destination: { type: "string", description: "Nombre del destino tal como aparece en Music Assistant" } },
          required: ["destination"], additionalProperties: false
        }
      }
    },
    async execute({ destination }, context = {}) {
      if (!String(destination || "").trim()) throw new Error("Indica el destino de música");
      const result = await music.setActiveDestination(destination, context.satelliteId);
      return { id: result.id, name: result.name, active: true };
    }
  };
}
