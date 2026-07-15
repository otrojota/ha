export function createSetActiveMusicDestinationTool({ music }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "music_set_active_destination",
        description: "Cambia de forma persistente el destino activo entre los dispositivos previamente agregados. Acepta nombre, alias o habitación.",
        parameters: {
          type: "object",
          properties: { destination: { type: "string", description: "Nombre, alias o habitación del destino" } },
          required: ["destination"], additionalProperties: false
        }
      }
    },
    async execute({ destination }) {
      if (!String(destination || "").trim()) throw new Error("Indica el destino de música");
      const result = await music.setActiveDestination(destination);
      return { id: result.id, name: result.alias || result.name, room: result.room, active: true };
    }
  };
}
