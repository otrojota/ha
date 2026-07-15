export function responseExpectsReply(text) {
  if (typeof text !== "string") return false;
  const normalized = text.trim();
  if (!normalized.endsWith("?")) return false;
  const openingQuestion = normalized.lastIndexOf("¿");
  return openingQuestion >= 0 && normalized.length - openingQuestion <= 280;
}
