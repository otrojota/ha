export function createGetCurrentMusicCreditsTool({ music }) {
  return {
    definition: { type: "function", function: {
      name: "music_get_current_credits",
      description: "Obtiene los créditos y metadatos que Music Assistant conoce para la canción actual. No deduce roles que Music Assistant no informe.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    } },
    async execute(args, context = {}) {
      if (!args || Object.keys(args).length) throw new Error("music_get_current_credits no acepta argumentos");
      const result = await music.getCurrentCredits(context.satelliteId);
      if (!result.item) return { message: "No hay una canción activa" };
      return {
        title: result.item.name,
        creditedArtists: result.item.artists || [],
        credits: result.credits || [],
        limitation: result.message || "Music Assistant no informó créditos detallados adicionales"
      };
    }
  };
}
