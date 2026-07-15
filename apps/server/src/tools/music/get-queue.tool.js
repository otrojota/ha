export function createGetMusicQueueTool({ music, spokenLimit = 10 }) {
  return {
    definition: { type: "function", function: {
      name: "music_get_queue",
      description: "Consulta la cola real de Music Assistant. Úsala siempre cuando pidan ver, mostrar, listar o consultar la cola de reproducción. Resume para voz sin inventar elementos.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    } },
    async execute(args) {
      if (!args || Object.keys(args).length) throw new Error("music_get_queue no acepta argumentos");
      const result = await music.getQueue();
      return {
        current: result.current,
        total: result.queue.length,
        queue: result.queue.slice(0, spokenLimit),
        truncated: result.queue.length > spokenLimit
      };
    }
  };
}
