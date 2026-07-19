export function createGetMusicQueueTool({ music, spokenLimit = 10 }) {
  return {
    definition: { type: "function", function: {
      name: "music_get_queue",
      description: "Consulta la cola real de Music Assistant, incluida la canción actual y la siguiente. Úsala para preguntas como qué viene después, qué canciones siguen o qué hay en la cola.",
      parameters: { type: "object", properties: { destination: { type: "string", description: "Nombre del parlante si el usuario menciona uno; omitir para usar el activo." } }, additionalProperties: false }
    } },
    async execute(args, context = {}) {
      if (!args || Object.keys(args).some((key) => key !== "destination")) throw new Error("Argumentos inválidos para music_get_queue");
      const result = await music.getQueue(args.destination, context.satelliteId);
      return {
        destination: result.destination?.name || null,
        currentIndex: result.currentIndex,
        current: result.current,
        next: result.next,
        upcoming: result.upcoming.slice(0, spokenLimit),
        totalUpcoming: result.upcoming.length,
        truncated: result.upcoming.length > spokenLimit
      };
    }
  };
}
