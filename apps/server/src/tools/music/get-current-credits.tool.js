export function createGetCurrentMusicCreditsTool({ music }) {
  return {
    definition: { type: "function", function: {
      name: "music_get_current_credits",
      description: "Obtiene créditos detallados de la canción actual: artista acreditado, vocalistas, músicos e instrumentos, compositores, letristas, productores e ingenieros. Úsala para quién canta, toca, compuso, escribió o produjo. Distingue crédito confirmado de ausencia de datos.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    } },
    async execute(args) {
      if (!args || Object.keys(args).length) throw new Error("music_get_current_credits no acepta argumentos");
      return music.getCurrentCredits();
    }
  };
}
