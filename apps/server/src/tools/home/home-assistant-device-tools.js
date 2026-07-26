function targetSchema(extra = {}) {
  return { type: "object", properties: {
    target: { type: "string", description: "Nombre del dispositivo o habitación, tal como lo expresó el usuario" },
    room: { type: "string", description: "Nombre de la habitación mencionada; omitir si el usuario no indicó una" },
    ...extra
  }, required: ["target", ...Object.keys(extra)], additionalProperties: false };
}

export function createHomeAssistantDeviceTools({ home, clientProvider, refresh }) {
  const control = async (target, room, domains, serviceFor) => {
    const devices = home.resolve(target, room, { domains });
    if (!devices.length) throw new Error(`“${target}” no contiene dispositivos compatibles con esta acción`);
    const client = clientProvider();
    if (!client) throw new Error("Home Assistant no está conectado");
    const results = [];
    for (const device of devices) {
      const { domain, service, data = {} } = serviceFor(device);
      await client.callService(domain, service, { entity_id: device.entityId, ...data });
      results.push({ name: device.name, entityId: device.entityId, action: `${domain}.${service}` });
    }
    await refresh();
    return { affected: results.map((item) => item.name), count: results.length, results };
  };
  return [
    {
      definition: { type: "function", function: { name: "home_get_device_state", description: "Consulta desde el catálogo de Home Assistant el estado de cualquier dispositivo, sensor o habitación, incluyendo planta, habitación, unidad y disponibilidad.", parameters: targetSchema() } },
      execute: ({ target, room }) => home.getCatalogState(target, room)
    },
    {
      definition: { type: "function", function: { name: "home_set_power", description: "Enciende o apaga interruptores y ventiladores de Home Assistant. Para luces usa las tools light_*.", parameters: targetSchema({ on: { type: "boolean" } }) } },
      execute: ({ target, room, on }) => control(target, room, ["switch", "fan"], (device) => ({ domain: device.domain, service: on ? "turn_on" : "turn_off" }))
    },
    {
      definition: { type: "function", function: { name: "cover_set_open", description: "Abre o cierra persianas, cortinas, puertas o cubiertas de Home Assistant.", parameters: targetSchema({ open: { type: "boolean" } }) } },
      execute: ({ target, room, open }) => control(target, room, ["cover"], () => ({ domain: "cover", service: open ? "open_cover" : "close_cover" }))
    },
    {
      definition: { type: "function", function: { name: "climate_set_temperature", description: "Ajusta la temperatura objetivo de un climatizador o termostato de Home Assistant.", parameters: targetSchema({ temperature: { type: "number", minimum: 5, maximum: 35 } }) } },
      execute: ({ target, room, temperature }) => control(target, room, ["climate"], () => ({ domain: "climate", service: "set_temperature", data: { temperature } }))
    },
    {
      definition: { type: "function", function: { name: "lock_set_locked", description: "Bloquea o desbloquea una cerradura de Home Assistant cuando el usuario lo pide explícitamente.", parameters: targetSchema({ locked: { type: "boolean" } }) } },
      execute: ({ target, room, locked }) => control(target, room, ["lock"], () => ({ domain: "lock", service: locked ? "lock" : "unlock" }))
    },
    {
      definition: { type: "function", function: { name: "vacuum_set_cleaning", description: "Inicia la limpieza o envía una aspiradora de Home Assistant de regreso a su base.", parameters: targetSchema({ cleaning: { type: "boolean" } }) } },
      execute: ({ target, room, cleaning }) => control(target, room, ["vacuum"], () => ({ domain: "vacuum", service: cleaning ? "start" : "return_to_base" }))
    }
  ];
}
