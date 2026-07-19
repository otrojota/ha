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
    const publicSchema = tool.definition.function.parameters;
    const schema = tool.internalParameters
      ? { ...publicSchema, properties: { ...publicSchema.properties, ...tool.internalParameters } }
      : publicSchema;
    validateArguments(schema, args);
    return tool.execute(args, context);
  }
}

function validateArguments(schema, value, path = "argumentos") {
  if (!schema) return;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} debe ser un objeto`);
    for (const key of schema.required || []) if (value[key] === undefined) throw new Error(`Falta el argumento obligatorio ${key}`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!schema.properties?.[key]) throw new Error(`Argumento desconocido: ${key}`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) validateArguments(child, value[key], key);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} debe ser una lista`);
    value.forEach((item, index) => validateArguments(schema.items, item, `${path}[${index}]`));
    return;
  }
  if (schema.type === "string" && typeof value !== "string") throw new Error(`${path} debe ser texto`);
  if (schema.type === "integer" && !Number.isInteger(value)) throw new Error(`${path} debe ser un entero`);
  if (schema.type === "number" && !Number.isFinite(value)) throw new Error(`${path} debe ser un número`);
  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} debe ser verdadero o falso`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} tiene un valor no permitido`);
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} no puede ser menor que ${schema.minimum}`);
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} no puede ser mayor que ${schema.maximum}`);
}
