function normalized(value) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es");
}

export function commandAfterWakeWord(transcript, wakeWord) {
  const source = normalized(transcript);
  const target = normalized(wakeWord);
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const index = source.search(new RegExp(`(^|[^\\p{L}])${escapedTarget}(?=$|[^\\p{L}])`, "u"));
  if (index < 0) return null;
  const wakeIndex = source.indexOf(target, index);
  return transcript.slice(wakeIndex + target.length).replace(/^[\s,.:;¡!¿?\-]+/, "").trim();
}
