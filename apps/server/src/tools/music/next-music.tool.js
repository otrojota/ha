export function createNextMusicTool({ music }) {
  return { definition: { type: "function", function: { name: "music_next", description: "Salta a la siguiente canción de la reproducción actual.", parameters: { type: "object", properties: { destination: { type: "string" } }, additionalProperties: false } } }, execute: ({ destination }) => music.next(destination) };
}
