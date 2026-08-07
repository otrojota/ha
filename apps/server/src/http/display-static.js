import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
  [".woff2", "font/woff2"]
]);

export const defaultDisplayDirectory = fileURLToPath(new URL("../../../display/public/", import.meta.url));

export function createDisplayStaticHandler({ directory = defaultDisplayDirectory } = {}) {
  const root = resolve(directory);
  return async function serveDisplay(request, response) {
    if (!["GET", "HEAD"].includes(request.method || "")) return false;
    const url = new URL(request.url || "/", "http://localhost");
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = resolve(root, relative);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return false;
    let metadata;
    try {
      metadata = await stat(filePath);
    } catch {
      return false;
    }
    if (!metadata.isFile()) return false;
    const contentType = CONTENT_TYPES.get(extname(filePath).toLowerCase()) || "application/octet-stream";
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Cache-Control", relative === "index.html" ? "no-store" : "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "HEAD") return response.end(), true;
    response.end(await readFile(filePath));
    return true;
  };
}
