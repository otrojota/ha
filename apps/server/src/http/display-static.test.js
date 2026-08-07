import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDisplayStaticHandler } from "./display-static.js";

function responseCapture() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body = "") { this.body = body; }
  };
}

test("sirve el index del display desde la raíz", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-display-"));
  await writeFile(join(directory, "index.html"), "<h1>Satélite</h1>");
  const response = responseCapture();
  assert.equal(await createDisplayStaticHandler({ directory })({ method: "GET", url: "/" }, response), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(response.body.toString(), "<h1>Satélite</h1>");
});

test("no sirve rutas inexistentes ni escapes del directorio público", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-display-"));
  const serve = createDisplayStaticHandler({ directory });
  assert.equal(await serve({ method: "GET", url: "/missing.js" }, responseCapture()), false);
  assert.equal(await serve({ method: "GET", url: "/..%2Fsecret" }, responseCapture()), false);
});
