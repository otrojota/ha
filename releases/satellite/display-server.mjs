import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = "/opt/ha/current/apps/display/public";
const port = Number(process.env.DISPLAY_PORT || 8080);
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = normalize(pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
    if (relative.startsWith("..")) throw new Error("invalid_path");
    let path = join(root, relative);
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": types[extname(path)] || "application/octet-stream"
    });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("No encontrado\n");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Display local disponible en http://127.0.0.1:${port}`);
});
