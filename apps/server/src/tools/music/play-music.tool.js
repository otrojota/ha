export function createPlayMusicTool({ music }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "music_play",
        description: "Reproduce una selección continua temporal. Usa mode=artist para 'música de X', mode=similar para 'del estilo de X', mode=playlist para una lista existente y mode=custom para una cola temporal con varios criterios. Nunca crea ni guarda playlists. Un destino mencionado queda activo persistentemente.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Artista, estilo, descripción o nombre principal solicitado" },
            destination: { type: "string", description: "Nombre, alias o habitación mencionada; omitir para usar el destino activo" },
            mode: { type: "string", enum: ["auto", "artist", "similar", "playlist", "custom"] },
            searches: { type: "array", items: { type: "string" }, maxItems: 12, description: "Búsquedas concretas para construir una cola temporal en mode=custom" },
            shuffle: { type: "boolean", description: "Usar orden aleatorio; normalmente true salvo petición contraria" }
          },
          required: ["query"], additionalProperties: false
        }
      }
    },
    async execute({ query, destination, mode = "auto", searches = [], shuffle = true }) {
      if (!String(query || "").trim()) throw new Error("Indica qué música reproducir");
      const result = await music.play({ query, destination, mode, searches, shuffle });
      return { status: result.status, item: result.item, destination: result.destination.alias || result.destination.name };
    }
  };
}
