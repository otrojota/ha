export function createSearchAndReadTool({ searchProvider, contentExtractor, maxResultsToTry = 3, log }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "web_search_and_read",
        description: "Busca información actual en la web, abre los primeros resultados públicos hasta encontrar uno legible y devuelve su texto, título y URL. Úsala para noticias, hechos recientes o información que no esté en otras herramientas.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 2, maxLength: 300, description: "Consulta concreta para el buscador web." }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    async execute(args, context) {
      const query = typeof args?.query === "string" ? args.query.trim() : "";
      if (query.length < 2 || query.length > 300) throw new Error("La consulta debe tener entre 2 y 300 caracteres");
      const results = await searchProvider.search(query, { locale: context.locale, limit: Math.max(5, maxResultsToTry) });
      if (!results.length) throw new Error("La búsqueda no devolvió resultados");
      const errors = [];
      for (const result of results.slice(0, maxResultsToTry)) {
        try {
          const page = await contentExtractor.extract(result.url);
          log("info", "Contenido web extraído", {
            query,
            title: page.title || result.title,
            url: page.finalUrl,
            characters: page.text.length,
            truncated: page.truncated
          });
          return {
            query,
            title: page.title || result.title,
            url: page.finalUrl,
            text: page.text,
            truncated: page.truncated,
            originalCharacters: page.originalCharacters,
            searchEngine: result.engine,
            retrievedAt: new Date().toISOString(),
            untrustedContent: true
          };
        } catch (error) {
          errors.push({ url: result.url, error: error.message });
          log("warn", "Resultado web descartado", { url: result.url, error: error.message });
        }
      }
      throw new Error(`No se pudo extraer texto de los primeros resultados: ${errors.map((item) => item.error).join("; ")}`);
    }
  };
}
