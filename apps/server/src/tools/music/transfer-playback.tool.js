export function createTransferMusicPlaybackTool({ music }) {
  return { definition: { type: "function", function: {
    name: "music_transfer_playback", description: "Transfiere la reproducción actual, conservando canción y posición, a un destino previamente agregado. El nuevo destino queda activo.",
    parameters: { type: "object", properties: { destination: { type: "string" }, play: { type: "boolean" } }, required: ["destination"], additionalProperties: false }
  } }, execute: ({ destination, play = true }) => music.transfer(destination, play) };
}
