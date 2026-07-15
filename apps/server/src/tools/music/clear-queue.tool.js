export function createClearMusicQueueTool({ music }) {
  return {
    definition: { type: "function", function: {
      name: "music_clear_queue",
      description: "Vacía la cola actual administrada por Music Assistant.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    } },
    async execute(args) {
      if (!args || Object.keys(args).length) throw new Error("music_clear_queue no acepta argumentos");
      const result = await music.clearQueue();
      return { status: result.status, cleared: result.cleared, remaining: result.remaining, message: result.message, destination: result.destination.alias || result.destination.name };
    }
  };
}
