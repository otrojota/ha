export function isMeaningfulVoiceCommand(text) {
  const normalized = String(text || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es").trim();
  if (!normalized) return false;
  if (/^[\[(]\s*(musica|music|silencio|silence|motor|ruido|noise|aplausos|applause)\s*[\])][.!?]*$/u.test(normalized)) return false;
  const spoken = normalized.replace(/[^\p{L}\p{N}]+/gu, "");
  return spoken.length >= 2;
}
