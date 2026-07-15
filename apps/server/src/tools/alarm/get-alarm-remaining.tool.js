function normalize(value) {
  return String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

function significantWords(value) {
  const ignored = new Set(["a", "al", "de", "el", "la", "para", "que", "un", "una"]);
  return normalize(value).split(/\s+/).filter((word) => word && !ignored.has(word));
}

function formatRemaining(totalSeconds) {
  if (totalSeconds < 60) return totalSeconds === 1 ? "1 segundo" : `${totalSeconds} segundos`;
  const units = [
    ["día", "días", 86_400],
    ["hora", "horas", 3_600],
    ["minuto", "minutos", 60]
  ];
  let remainder = totalSeconds;
  const parts = [];
  for (const [singular, plural, size] of units) {
    const amount = Math.floor(remainder / size);
    if (amount) {
      parts.push(`${amount} ${amount === 1 ? singular : plural}`);
      remainder %= size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" y ");
}

function withRemaining(alarm, now) {
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(alarm.scheduledFor) - now.getTime()) / 1000));
  return {
    id: alarm.id,
    kind: alarm.kind,
    label: alarm.label,
    scheduledFor: alarm.scheduledFor,
    remainingSeconds,
    remainingText: formatRemaining(remainingSeconds)
  };
}

export function createGetAlarmRemainingTool({ scheduler }) {
  return {
    definition: {
      type: "function",
      function: {
        name: "alarm_get_remaining",
        description: "Indica cuánto falta para la próxima alarma o para una alarma específica buscada por su etiqueta. Debe usarse para preguntas como 'cuánto falta para la siguiente alarma' o 'cuánto falta para acostar a Memo'. No uses tools datetime para calcular esta diferencia.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Texto distintivo de la etiqueta, por ejemplo 'acostar a Memo'. Omítelo para consultar la próxima alarma."
            }
          },
          additionalProperties: false
        }
      }
    },
    async execute(args, context) {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Los argumentos de alarm_get_remaining no son válidos");
      if (Object.keys(args).some((key) => key !== "query")) throw new Error("alarm_get_remaining sólo acepta query");
      if (args.query !== undefined && typeof args.query !== "string") throw new Error("query debe ser texto");
      if (!context.satelliteId) throw new Error("No hay un satélite de destino");

      const alarms = scheduler.list(context.satelliteId);
      const query = normalize(args.query);
      const matches = query
        ? alarms.filter((alarm) => {
          const label = normalize(alarm.label);
          const words = significantWords(args.query);
          const labelWords = new Set(significantWords(alarm.label));
          return Boolean(label) && (label.includes(query) || query.includes(label) || (words.length > 0 && words.every((word) => labelWords.has(word))));
        })
        : alarms.slice(0, 1);
      const now = context.now?.() || new Date();
      const results = matches.map((alarm) => withRemaining(alarm, now));
      return {
        found: results.length > 0,
        ambiguous: results.length > 1,
        query: args.query || null,
        timeZone: context.timeZone,
        alarms: results
      };
    }
  };
}

export { formatRemaining };
