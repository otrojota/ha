import os from "node:os";
import { readFile, statfs } from "node:fs/promises";

function cpuTimes() {
  return os.cpus().reduce((result, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return { idle: result.idle + cpu.times.idle, total: result.total + total };
  }, { idle: 0, total: 0 });
}

async function cpuUsage(sampleMilliseconds = 200) {
  const before = cpuTimes();
  await new Promise((resolve) => setTimeout(resolve, sampleMilliseconds));
  const after = cpuTimes();
  const total = after.total - before.total;
  return total > 0 ? Math.max(0, Math.min(100, (1 - (after.idle - before.idle) / total) * 100)) : 0;
}

async function operatingSystem() {
  try {
    const content = await readFile("/etc/os-release", "utf8");
    const values = Object.fromEntries(content.split("\n").map((line) => line.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((match) => [match[1], match[2].replace(/^"|"$/g, "")]));
    return values.PRETTY_NAME || values.NAME || `${os.type()} ${os.release()}`;
  } catch {
    return `${os.type()} ${os.release()}`;
  }
}

async function availableMemory() {
  try {
    const content = await readFile("/proc/meminfo", "utf8");
    const match = content.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (match) return Number(match[1]) * 1024;
  } catch {}
  return os.freemem();
}

async function rootDisk() {
  try {
    const info = await statfs("/");
    const total = info.blocks * info.bsize;
    const available = info.bavail * info.bsize;
    return { total, available, used: total - available };
  } catch {
    return null;
  }
}

async function cpuTemperature() {
  try {
    const value = Number((await readFile("/sys/class/thermal/thermal_zone0/temp", "utf8")).trim());
    return Number.isFinite(value) ? value / 1000 : null;
  } catch {
    return null;
  }
}

function networkAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([interfaceName, addresses = []]) => addresses
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => ({ interface: interfaceName, address: address.address })));
}

function systemUptime() {
  try {
    return os.uptime();
  } catch {
    return null;
  }
}

export async function getSystemInformation({ satelliteVersion = null, server = null } = {}) {
  const [cpuPercent, systemName, memoryAvailable, disk, temperatureCelsius] = await Promise.all([
    cpuUsage(), operatingSystem(), availableMemory(), rootDisk(), cpuTemperature()
  ]);
  const memoryTotal = os.totalmem();
  return {
    version: satelliteVersion,
    server,
    hostname: os.hostname(),
    operatingSystem: systemName,
    kernel: `${os.type()} ${os.release()}`,
    architecture: os.arch(),
    nodeVersion: process.version,
    uptimeSeconds: systemUptime(),
    cpu: { model: os.cpus()[0]?.model?.trim() || "Desconocido", cores: os.cpus().length, usagePercent: cpuPercent, loadAverage: os.loadavg(), temperatureCelsius },
    memory: { total: memoryTotal, available: memoryAvailable, used: Math.max(0, memoryTotal - memoryAvailable) },
    disk,
    network: networkAddresses()
  };
}
