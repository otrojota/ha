export function env(name, fallback) {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Falta la variable de entorno ${name}`);
}

export function jsonLog(level, message, context = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...context }));
}

