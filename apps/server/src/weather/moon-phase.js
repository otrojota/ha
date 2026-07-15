const synodicMonthDays = 29.530588853;
const referenceNewMoonMs = Date.parse("2000-01-06T18:14:00Z");
const phases = [
  { name: "Luna nueva", icon: "🌑" },
  { name: "Luna creciente", icon: "🌒" },
  { name: "Cuarto creciente", icon: "🌓" },
  { name: "Gibosa creciente", icon: "🌔" },
  { name: "Luna llena", icon: "🌕" },
  { name: "Gibosa menguante", icon: "🌖" },
  { name: "Cuarto menguante", icon: "🌗" },
  { name: "Luna menguante", icon: "🌘" }
];

export function getMoonPhase(date = new Date()) {
  const daysSinceReference = (date.getTime() - referenceNewMoonMs) / 86_400_000;
  const ageDays = ((daysSinceReference % synodicMonthDays) + synodicMonthDays) % synodicMonthDays;
  const fraction = ageDays / synodicMonthDays;
  const index = Math.round(fraction * 8) % 8;
  return { ...phases[index], ageDays: Number(ageDays.toFixed(1)), fraction: Number(fraction.toFixed(3)) };
}
