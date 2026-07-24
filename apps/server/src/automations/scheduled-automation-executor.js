export class ScheduledAutomationExecutor {
  constructor({ home, music, executeTool, log = () => {} }) {
    this.home = home; this.music = music; this.executeTool = executeTool; this.log = log;
  }

  async execute(automation) {
    const results = [];
    for (const action of automation.actions || []) {
      try {
        const result = await this.executeAction(action, automation.satelliteId);
        results.push({ type: action.type, success: true, result });
      } catch (error) {
        this.log("warn", "Falló una acción programada", { automationId: automation.id, type: action.type, error: error.message });
        results.push({ type: action.type, success: false, error: error.message });
      }
    }
    return { success: results.every((result) => result.success), results };
  }

  executeAction(action, satelliteId) {
    if (this.executeTool) {
      const { type, ...args } = action;
      return this.executeTool(type, args, { satelliteId });
    }
    if (action.type === "light_turn_on") return this.home.setPower(action.target, true);
    if (action.type === "light_turn_off") return this.home.setPower(action.target, false);
    if (action.type === "light_set_brightness") return this.home.setBrightness(action.target, action.brightnessPercent);
    if (action.type === "light_set_color") return this.home.setColor(action.target, action);
    if (action.type === "light_set_color_temperature") return this.home.setColorTemperature(action.target, action.temperaturePercent);
    if (action.type === "music_play") return this.playMusic(action, satelliteId);
    if (action.type === "music_pause") return this.music.pause(action.destination, satelliteId);
    if (action.type === "music_resume") return this.music.resume(action.destination, satelliteId);
    throw new Error(`Acción programada desconocida: ${action.type}`);
  }

  async playMusic(action, satelliteId) {
    const result = await this.music.play({ query: action.query, destination: action.destination, source: action.source, mode: action.mode, shuffle: action.shuffle }, satelliteId);
    if (result.clarificationRequired) throw new Error(`La selección musical “${action.query}” resultó ambigua`);
    return result;
  }
}
