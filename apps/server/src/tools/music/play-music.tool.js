export function createPlayMusicTool({ music }) {
  return {
    // Argumento reservado para reproducir una opción ya resuelta por el
    // servidor. No se incluye en la definición enviada al LLM.
    internalParameters: {
      mediaUri: { type: "string" }
    },
    definition: {
      type: "function",
      function: {
        name: "music_play",
        description: "Reproduce música o radio. Usa mode=radio para una emisora guardada; mode=artist para música general de un artista recorriendo las pistas de todos sus álbumes; mode=popular para sus canciones más populares; mode=similar para canciones parecidas a una canción concreta; mode=album para un álbum completo; mode=playlist para una lista existente y mode=custom para una cola temporal. Nunca crea ni guarda playlists. Un destino mencionado queda activo persistentemente.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Artista, estilo, descripción o nombre principal solicitado" },
            destination: { type: "string", description: "Nombre del destino en Music Assistant; omitir para usar el destino activo" },
            source: { type: "string", description: "Origen de Music Assistant mencionado, por ejemplo Tidal, Spotify o biblioteca local; omitir para usar el origen activo" },
            mode: { type: "string", enum: ["auto", "artist", "popular", "album", "similar", "playlist", "radio", "custom"] },
            searches: { type: "array", items: { type: "string" }, maxItems: 12, description: "Búsquedas concretas para construir una cola temporal en mode=custom" },
            shuffle: { type: "boolean", description: "Usar orden aleatorio; normalmente true salvo petición contraria" }
          },
          required: ["query"], additionalProperties: false
        }
      }
    },
    async execute({ query, destination, source, mode = "auto", searches = [], shuffle, mediaUri }, context = {}) {
      if (!String(query || "").trim()) throw new Error("Indica qué música reproducir");
      const effectiveShuffle = mode === "album" ? false : mode === "popular" ? shuffle === true : shuffle !== false;
      const result = await music.play({ query, destination, mode, searches, shuffle: effectiveShuffle, ...(source ? { source } : {}), ...(mediaUri ? { mediaUri } : {}) }, context.satelliteId);
      if (result.clarificationRequired) return {
        clarificationRequired: true, query: result.query, choices: result.choices,
        request: { destination, source, mode, shuffle: effectiveShuffle }
      };
      return { status: result.status, item: result.item, destination: result.destination.name, source: result.source?.name };
    }
  };
}
