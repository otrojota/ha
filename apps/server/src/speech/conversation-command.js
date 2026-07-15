function normalized(value) {
  return String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function isConversationResetCommand(text) {
  const value = normalized(text);
  return /^(olvida|borra|limpia) (esta |nuestra |la )?(conversacion|memoria|contexto)( por favor)?$/.test(value)
    || /^(empecemos|comencemos) de nuevo( por favor)?$/.test(value)
    || /^(nueva|reinicia la) conversacion( por favor)?$/.test(value);
}
