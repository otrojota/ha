export function createPauseMusicTool({ music }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "music_pause",
        description: "Pausa la música en el destino activo o en un destino agregado mencionado por el usuario. Si se menciona, queda activo persistentemente.",
        parameters: {
          type: "object",
          properties: { destination: { type: "string", description: "Nombre, alias o habitación; omitir para usar el activo" } },
          additionalProperties: false
        }
      }
    },
    async execute({ destination }) {
      const result = await music.pause(destination);
      return { status: result.status, destination: result.destination.alias || result.destination.name };
    }
  };
}
