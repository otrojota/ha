const descriptions = new Map([
  [0, "Despejado"], [1, "Mayormente despejado"], [2, "Parcialmente nublado"], [3, "Nublado"],
  [45, "Niebla"], [48, "Niebla con escarcha"], [51, "Llovizna ligera"], [53, "Llovizna"],
  [55, "Llovizna intensa"], [56, "Llovizna helada ligera"], [57, "Llovizna helada intensa"],
  [61, "Lluvia ligera"], [63, "Lluvia"], [65, "Lluvia intensa"], [66, "Lluvia helada ligera"],
  [67, "Lluvia helada intensa"], [71, "Nevada ligera"], [73, "Nevada"], [75, "Nevada intensa"],
  [77, "Granos de nieve"], [80, "Chubascos ligeros"], [81, "Chubascos"], [82, "Chubascos intensos"],
  [85, "Chubascos de nieve ligeros"], [86, "Chubascos de nieve intensos"], [95, "Tormenta"],
  [96, "Tormenta con granizo ligero"], [99, "Tormenta con granizo intenso"]
]);

export function describeWeatherCode(code) {
  return descriptions.get(Number(code)) || "Condiciones desconocidas";
}

export function weatherIcon(code, isDay = true) {
  const value = Number(code);
  if (value === 0) return isDay ? "☀️" : "🌙";
  if ([1, 2].includes(value)) return isDay ? "🌤️" : "☁️🌙";
  if (value === 3) return "☁️";
  if ([45, 48].includes(value)) return "🌫️";
  if ([51, 53, 55, 56, 57].includes(value)) return "🌦️";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(value)) return "🌨️";
  if ([95, 96, 99].includes(value)) return "⛈️";
  return "🌡️";
}
