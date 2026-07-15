export function createGetMusicPlaybackTool({ music }) {
  return {
    definition: { type: "function", function: {
      name: "music_get_playback",
      description: "Consulta en Spotify la canción que suena ahora y devuelve título, artistas, álbum, duración, progreso, dispositivo, volumen, shuffle y repetición. Úsala siempre para 'qué suena' o pedir detalles de la canción actual.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    } },
    async execute(args) {
      if (!args || Object.keys(args).length) throw new Error("music_get_playback no acepta argumentos");
      return music.getPlayback();
    }
  };
}
