export function alarmLocalTime(instant, timeZone, locale = "es-CL") {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) throw new Error("El instante del aviso no es válido");
  const zone = String(timeZone || "UTC");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName.replace("GMT", "");
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localTime = `${parts.hour}:${parts.minute}`;
  return {
    scheduledFor: `${localDate}T${parts.hour}:${parts.minute}:${parts.second}${offset}`,
    scheduledForUtc: date.toISOString(),
    localDate,
    localTime,
    timeZone: zone,
    localText: new Intl.DateTimeFormat(locale || "es-CL", {
      timeZone: zone,
      dateStyle: "full",
      timeStyle: "short"
    }).format(date)
  };
}
