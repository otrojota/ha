export function createResumeMusicTool({ music }) {
  return simpleDestinationTool("music_resume", "Continúa la reproducción pausada en el destino activo o mencionado.", (destination, satelliteId) => music.resume(destination, satelliteId));
}
function simpleDestinationTool(name, description, execute) {
  return { definition: { type: "function", function: { name, description, parameters: { type: "object", properties: { destination: { type: "string" } }, additionalProperties: false } } }, execute: ({ destination }, context = {}) => execute(destination, context.satelliteId) };
}
