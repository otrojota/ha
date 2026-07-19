export function createGetMusicPlaybackTool({ music }) {
  return {
    definition: { type: "function", function: {
      name: "music_get_playback",
      description: "Consulta qué suena en el destino activo de este satélite o en un parlante mencionado explícitamente. Devuelve título, artistas, álbum, progreso y destino.",
      parameters: { type: "object", properties: {
        destination: { type: "string", description: "Nombre del parlante en Music Assistant; omitir para usar el destino activo de este satélite" }
      }, additionalProperties: false }
    } },
    async execute({ destination } = {}, context = {}) {
      return music.getPlayback(destination, context.satelliteId);
    }
  };
}
