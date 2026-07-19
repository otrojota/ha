function targetParameters(extra = {}) {
  return { type: "object", properties: {
    target: { type: "string", description: "Nombre de la luz o habitación, tal como lo expresó el usuario" },
    room: { type: "string", description: "Nombre de la habitación mencionada por el usuario; omitir si no indicó una" },
    ...extra
  }, required: ["target", ...Object.keys(extra)], additionalProperties: false };
}

function percent(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${name} debe estar entre 0 y 100`);
  return value;
}

export function createHomeLightTools({ home }) {
  return [
    { definition: { type: "function", function: { name: "home_list_devices", description: "Lista las luces y otros dispositivos domésticos habilitados, incluyendo sus habitaciones.", parameters: { type: "object", properties: {}, additionalProperties: false } } }, execute: () => ({ devices: home.list() }) },
    { definition: { type: "function", function: { name: "light_get_state", description: "Consulta el estado real de una luz o de las luces de una habitación.", parameters: targetParameters() } }, execute: ({ target, room }) => home.getState(target, room) },
    { definition: { type: "function", function: { name: "light_turn_on", description: "Enciende una luz o todas las luces de una habitación.", parameters: targetParameters() } }, execute: ({ target, room }) => home.setPower(target, true, room) },
    { definition: { type: "function", function: { name: "light_turn_off", description: "Apaga una luz o todas las luces de una habitación.", parameters: targetParameters() } }, execute: ({ target, room }) => home.setPower(target, false, room) },
    { definition: { type: "function", function: { name: "light_set_brightness", description: "Enciende y establece el nivel final de brillo de una luz o habitación. Convierte ‘a la mitad’ en 50. No es un cambio relativo.", parameters: targetParameters({ brightnessPercent: { type: "number", minimum: 1, maximum: 100, description: "Porcentaje final exacto solicitado por el usuario: mitad=50, diez por ciento=10" } }) } }, execute: ({ target, room, brightnessPercent }) => home.setBrightness(target, percent(brightnessPercent, "brightnessPercent"), room) },
    { definition: { type: "function", function: { name: "light_set_color", description: "Enciende y establece un color HSV. Convierte nombres comunes de colores a tono HSV antes de llamar esta tool.", parameters: targetParameters({ hue: { type: "number", minimum: 0, maximum: 360, description: "Tono: rojo 0, amarillo 60, verde 120, cian 180, azul 240, magenta 300" }, saturationPercent: { type: "number", minimum: 0, maximum: 100 }, brightnessPercent: { type: "number", minimum: 1, maximum: 100 } }) } }, execute: ({ target, room, hue, saturationPercent, brightnessPercent }) => {
      if (!Number.isFinite(hue) || hue < 0 || hue > 360) throw new Error("hue debe estar entre 0 y 360");
      return home.setColor(target, { hue, saturationPercent: percent(saturationPercent, "saturationPercent"), brightnessPercent: percent(brightnessPercent, "brightnessPercent") }, room);
    } },
    { definition: { type: "function", function: { name: "light_set_color_temperature", description: "Enciende y ajusta el blanco de una luz: 0 es el blanco más cálido y 100 el más frío.", parameters: targetParameters({ temperaturePercent: { type: "number", minimum: 0, maximum: 100 } }) } }, execute: ({ target, room, temperaturePercent }) => home.setColorTemperature(target, percent(temperaturePercent, "temperaturePercent"), room) }
  ];
}
