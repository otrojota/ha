const SUPPORTED_DOMAINS = new Set(["light", "switch", "sensor", "binary_sensor", "climate", "cover", "fan", "lock", "media_player", "vacuum"]);
const EXCLUDED_PLATFORMS = new Set(["backup", "sun"]);

function entityDomain(entityId) { return String(entityId || "").split(".")[0]; }
function deviceType(domain) { return domain === "light" ? "rgb_bulb" : domain; }
function isRelevantEntity(state, entity = {}) {
  if (!SUPPORTED_DOMAINS.has(entityDomain(state.entity_id))) return false;
  if (EXCLUDED_PLATFORMS.has(String(entity.platform || "").toLowerCase())) return false;
  return !/^(?:sensor|binary_sensor)\.(?:backup(?:_|$)|sun(?:_|$))/i.test(String(state.entity_id || ""));
}

export class HomeAssistantCatalog {
  constructor({ clientProvider, log = () => {} }) {
    this.clientProvider = clientProvider;
    this.log = log;
    this.state = { floors: [], rooms: [], devices: [], refreshedAt: null, stale: true, error: null };
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async optionalRegistry(client, type) {
    try { return await client.websocketCommand(type); }
    catch (error) { this.log("warn", "Registro opcional de Home Assistant no disponible", { type, error: error.message }); return []; }
  }

  async refresh() {
    const client = this.clientProvider();
    if (!client) {
      this.state = { ...this.state, stale: true, error: "Configura primero la conexión con Home Assistant" };
      return this.snapshot();
    }
    try {
      const [states, floors, areas, registryDevices, registryEntities] = await Promise.all([
        client.states(),
        this.optionalRegistry(client, "config/floor_registry/list"),
        this.optionalRegistry(client, "config/area_registry/list"),
        this.optionalRegistry(client, "config/device_registry/list"),
        this.optionalRegistry(client, "config/entity_registry/list")
      ]);
      const deviceById = new Map(registryDevices.map((device) => [device.id, device]));
      const entityById = new Map(registryEntities.map((entity) => [entity.entity_id, entity]));
      const areaById = new Map(areas.map((area) => [area.area_id, area]));
      const floorById = new Map(floors.map((floor) => [floor.floor_id, floor]));
      const devices = states.filter((state) => isRelevantEntity(state, entityById.get(state.entity_id))).map((state) => {
        const entity = entityById.get(state.entity_id) || {};
        const registryDevice = deviceById.get(entity.device_id) || {};
        const areaId = entity.area_id || registryDevice.area_id || null;
        const area = areaById.get(areaId) || null;
        const floorId = area?.floor_id || null;
        const floor = floorById.get(floorId) || null;
        const domain = entityDomain(state.entity_id);
        return {
          id: state.entity_id,
          entityId: state.entity_id,
          name: entity.name || state.attributes?.friendly_name || registryDevice.name_by_user || registryDevice.name || state.entity_id,
          deviceName: registryDevice.name_by_user || registryDevice.name || null,
          roomId: areaId,
          room: area?.name || null,
          floorId,
          floor: floor?.name || null,
          domain,
          type: deviceType(domain),
          provider: "home_assistant",
          enabled: entity.disabled_by == null,
          available: state.state !== "unavailable",
          state: state.state,
          unit: state.attributes?.unit_of_measurement || null,
          capabilities: domain === "light" ? ["power", "brightness", "color", "color_temperature"]
            : ["switch", "fan", "cover", "lock"].includes(domain) ? ["power"] : ["state"],
          configuration: { entityId: state.entity_id }
        };
      });
      this.state = {
        floors: floors.map((floor) => ({ id: floor.floor_id, name: floor.name })),
        rooms: areas.map((area) => ({ id: area.area_id, name: area.name, floorId: area.floor_id || null })),
        devices, refreshedAt: new Date().toISOString(), stale: false, error: null
      };
    } catch (error) {
      this.state = { ...this.state, stale: true, error: error.message };
      this.log("warn", "No se pudo refrescar el catálogo de Home Assistant", { error: error.message });
    }
    return this.snapshot();
  }
}
