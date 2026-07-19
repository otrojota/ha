export function createPreviousMusicTool({ music }) {
  return { definition: { type: "function", function: { name: "music_previous", description: "Vuelve a la canción anterior de la reproducción actual.", parameters: { type: "object", properties: { destination: { type: "string" } }, additionalProperties: false } } }, execute: ({ destination }, context = {}) => music.previous(destination, context.satelliteId) };
}
