export function createSetActiveMusicSourceTool({ music }) {
  return {
    definition: { type: "function", function: {
      name: "music_set_active_source",
      description: "Cambia por nombre el origen musical activo de Music Assistant y lo conserva para futuras reproducciones.",
      parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"], additionalProperties: false }
    } },
    async execute({ source }) {
      if (!String(source || "").trim()) throw new Error("Indica el origen musical");
      return music.setActiveSource(source);
    }
  };
}
