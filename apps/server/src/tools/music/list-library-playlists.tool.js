export function createListLibraryPlaylistsTool({ music, spokenLimit = 20 }) {
  return {
    definition: { type: "function", function: {
      name: "music_list_library_playlists",
      description: "Lista las playlists o listas de reproducción disponibles en la biblioteca de Music Assistant. No reproduce, crea ni modifica listas.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    } },
    async execute(args, context = {}) {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
        throw new Error("music_list_library_playlists no acepta argumentos");
      }
      const result = await music.getLibraryPlaylists(context.satelliteId);
      const playlists = (result.playlists || []).map((playlist) => ({
        name: playlist.name,
        provider: playlist.provider || null,
        uri: playlist.uri || null
      }));
      return {
        total: result.total ?? playlists.length,
        playlists: playlists.slice(0, spokenLimit),
        truncated: playlists.length > spokenLimit
      };
    }
  };
}
