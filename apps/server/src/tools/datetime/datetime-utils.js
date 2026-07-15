function parts(date, locale, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function localDateAt(date, locale, timeZone) {
  const value = parts(date, locale, timeZone);
  return `${value.year}-${value.month}-${value.day}`;
}

export function addCalendarDays(isoDate, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  if (!match) throw new Error("La fecha debe usar el formato YYYY-MM-DD");
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  if (!days && (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)) throw new Error("La fecha no existe");
  return date.toISOString().slice(0, 10);
}

export function formatDateInfo(isoDate, locale, timeZone) {
  const validDate = addCalendarDays(isoDate, 0);
  const [year, month, day] = validDate.split("-").map(Number);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12));
  return {
    date: validDate,
    weekday: new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long" }).format(noonUtc),
    shortDate: new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: "short" }).format(noonUtc),
    longDate: new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: "full" }).format(noonUtc)
  };
}

export function daysBetween(startDate, endDate) {
  const start = Date.parse(`${addCalendarDays(startDate, 0)}T00:00:00Z`);
  const end = Date.parse(`${addCalendarDays(endDate, 0)}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export function currentDateTime(now, locale, timeZone) {
  const value = parts(now, locale, timeZone);
  const date = `${value.year}-${value.month}-${value.day}`;
  return {
    instant: now.toISOString(),
    locale,
    timeZone,
    utcOffset: value.timeZoneName,
    date,
    time: `${value.hour}:${value.minute}:${value.second}`,
    ...formatDateInfo(date, locale, timeZone)
  };
}
