export function removeGenericFollowUp(text) {
  if (typeof text !== "string") return text;
  return text.replace(
    /\s*[¿]?\s*(?:quieres|necesitas|deseas)\s+(?:que\s+(?:haga|te\s+ayude\s+con)\s+)?algo\s+m[aá]s\s*\?\s*$/iu,
    ""
  ).replace(
    /\s*[¿]?\s*(?:hay\s+algo\s+m[aá]s\s+en\s+que\s+(?:pueda\s+)?ayudarte|en\s+qu[eé]\s+m[aá]s\s+puedo\s+ayudarte)\s*\?\s*$/iu,
    ""
  ).trim();
}

export function responseExpectsReply(text) {
  if (typeof text !== "string") return false;
  const normalized = text.trim();
  if (!normalized) return false;

  // Algunos modelos omiten el signo de apertura español, agregan comillas al
  // final o entregan alternativas largas antes de hacer la pregunta.
  if (/\?[\s\]})"'»”]*$/u.test(normalized)) return true;

  // También hay aclaraciones formuladas como una petición directa, sin signo
  // de interrogación. Se restringe a verbos que solicitan datos para evitar
  // abrir el micrófono después de una respuesta meramente informativa.
  const folded = normalized.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return /(?:^|[.!]\s+)(?:por favor[,\s]+)?(?:dime|indica(?:me)?|especifica(?:me)?|aclara(?:me)?|elige|selecciona|confirma)\b[^.!?]*[.!]?$/iu.test(folded);
}
