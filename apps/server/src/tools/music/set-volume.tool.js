export function createSetMusicVolumeTool({ music }) {
  return { definition: { type: "function", function: {
    name: "music_set_volume", description: "Establece el volumen Spotify Connect del destino activo o mencionado.",
    parameters: { type: "object", properties: { volumePercent: { type: "integer", minimum: 0, maximum: 100 }, changePercent: { type: "integer", minimum: -100, maximum: 100, description: "Cambio relativo, por ejemplo 10 para subir o -10 para bajar" }, destination: { type: "string" } }, additionalProperties: false }
  } }, execute: ({ volumePercent, changePercent, destination }) => music.setVolume(volumePercent, destination, changePercent) };
}
