export class ToolRegistry {
  constructor(tools) {
    this.tools = new Map(tools.map((tool) => [tool.definition.function.name, tool]));
  }

  definitions() {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  async execute(name, args, context) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool desconocida: ${name}`);
    return tool.execute(args, context);
  }
}
