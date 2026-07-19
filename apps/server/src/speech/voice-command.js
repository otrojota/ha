export function normalizeVoiceText(text) {
  return String(text || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function isAssistantNameOnly(text, assistantName) {
  const normalizedName = normalizeVoiceText(assistantName);
  return Boolean(normalizedName) && normalizeVoiceText(text) === normalizedName;
}

export function isMeaningfulVoiceCommand(text) {
  const normalized = String(text || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es").trim();
  if (!normalized) return false;
  if (/^[\[(]\s*(musica|music|silencio|silence|motor|ruido|noise|aplausos|applause)\s*[\])][.!?]*$/u.test(normalized)) return false;
  const spoken = normalized.replace(/[^\p{L}\p{N}]+/gu, "");
  return spoken.length >= 2;
}
