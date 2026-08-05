import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const publicDirectory = fileURLToPath(new URL("../../public/wake-word/", import.meta.url));
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

async function readBody(request, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new Error(`La solicitud supera el máximo de ${Math.round(maximum / 1024 / 1024)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const buffer = await readBody(request, 256 * 1024);
  return buffer.length ? JSON.parse(buffer.toString("utf8")) : {};
}

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function statusFor(error) {
  if (["MODEL_NOT_FOUND", "JOB_NOT_FOUND"].includes(error.code)) return 404;
  if (["MODEL_EXISTS", "TRAINING_ACTIVE"].includes(error.code)) return 409;
  if (["TRAINER_UNAVAILABLE", "MODEL_FILE_MISSING"].includes(error.code)) return 409;
  return 400;
}

async function serveAsset(pathname, response) {
  const relative = pathname === "/wake-word" || pathname === "/wake-word/" ? "index.html" : pathname.slice("/wake-word/".length);
  if (!["index.html", "app.css", "app.js"].includes(relative)) return false;
  response.setHeader("Content-Type", contentTypes[extname(relative)] || "application/octet-stream");
  response.setHeader("Cache-Control", relative === "index.html" ? "no-store" : "public, max-age=300");
  response.end(await readFile(join(publicDirectory, relative)));
  return true;
}

export function createWakeWordHttpHandler({ store, training }) {
  return async function handleWakeWordRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && (url.pathname === "/wake-word" || url.pathname.startsWith("/wake-word/"))) {
      return serveAsset(url.pathname, response);
    }
    if (!url.pathname.startsWith("/api/wake-word/")) return false;

    try {
      const segments = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && url.pathname === "/api/wake-word/models") {
        return json(response, 200, { models: await store.list(), ...training.capabilities() });
      }
      if (request.method === "POST" && url.pathname === "/api/wake-word/models") {
        return json(response, 201, { model: await store.create(await readJson(request)) });
      }
      if (request.method === "GET" && url.pathname === "/api/wake-word/jobs") {
        return json(response, 200, { jobs: training.listJobs() });
      }
      if (request.method === "GET" && segments[2] === "jobs" && segments.length === 4) {
        return json(response, 200, { job: training.job(segments[3]) });
      }
      if (segments[2] !== "models" || !segments[3]) return false;
      const id = segments[3];
      if (request.method === "GET" && segments.length === 4) {
        return json(response, 200, { model: await store.describe(id), ...training.capabilities() });
      }
      if (request.method === "PUT" && segments.length === 4) {
        return json(response, 200, { model: await store.update(id, await readJson(request)) });
      }
      if (request.method === "DELETE" && segments.length === 4) {
        await store.remove(id);
        response.statusCode = 204;
        return response.end();
      }
      if (segments[4] === "file" && request.method === "PUT" && segments.length === 5) {
        const body = await readBody(request, 50 * 1024 * 1024);
        const originalName = request.headers["x-file-name"] || `${id}.onnx`;
        return json(response, 200, { model: await store.replaceModelFile(id, body, originalName) });
      }
      if (segments[4] === "download" && request.method === "GET" && segments.length === 5) {
        const { metadata, buffer } = await store.readModelFile(id);
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("Content-Length", buffer.length);
        response.setHeader("Content-Disposition", `attachment; filename="${metadata.file.name}"`);
        response.setHeader("Last-Modified", new Date(metadata.file.modifiedAt).toUTCString());
        response.setHeader("ETag", `"sha256-${metadata.file.sha256}"`);
        response.setHeader("X-Model-Modified-At", metadata.file.modifiedAt);
        response.setHeader("X-Model-Sha256", metadata.file.sha256);
        return response.end(buffer);
      }
      if (segments[4] === "samples" && request.method === "POST" && segments[5] && segments.length === 6) {
        const body = await readBody(request, 20 * 1024 * 1024);
        const originalName = request.headers["x-file-name"] || "sample.wav";
        return json(response, 201, { model: await store.addSample(id, segments[5], body, originalName) });
      }
      if (segments[4] === "test" && request.method === "POST" && segments.length === 5) {
        const body = await readBody(request, 20 * 1024 * 1024);
        const threshold = Number(request.headers["x-wake-word-threshold"] || "0.995");
        if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) throw new Error("El umbral de prueba es inválido");
        return json(response, 200, { evaluation: await training.evaluate(id, body, { threshold }) });
      }
      if (segments[4] === "train" && request.method === "POST" && segments.length === 5) {
        return json(response, 202, { job: await training.start(id, await readJson(request)) });
      }
      return false;
    } catch (error) {
      return json(response, statusFor(error), { error: error.code || "invalid_wake_word_request", message: error.message });
    }
  };
}
