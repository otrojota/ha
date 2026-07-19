export function createAddToMusicQueueTool({ music }) {
  return { definition: { type: "function", function: {
    name: "music_add_to_queue", description: "Busca una canción y la agrega después de la reproducción actual sin reemplazar la cola.",
    parameters: { type: "object", properties: { query: { type: "string" }, destination: { type: "string" } }, required: ["query"], additionalProperties: false }
  } }, execute: ({ query, destination }, context = {}) => music.addToQueue(query, destination, context.satelliteId) };
}
