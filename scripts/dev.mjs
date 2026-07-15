import { spawn } from "node:child_process";

const services = [
  ["music", ["run", "dev", "--workspace", "@ha/music-gateway"]],
  ["server", ["run", "dev", "--workspace", "@ha/server"]],
  ["display", ["run", "dev", "--workspace", "@ha/display"]],
  ["satellite", ["run", "dev", "--workspace", "@ha/satellite"]]
];

const children = services.map(([name, args]) => {
  const child = spawn("npm", args, { stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`[${name}] terminó con código ${code}`);
  });
  return child;
});

function stop() {
  for (const child of children) child.kill("SIGTERM");
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

