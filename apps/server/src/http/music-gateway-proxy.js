const PREFIX = "/music-gateway";

async function requestBody(request, limit = 1_048_576) {
  if (["GET", "HEAD"].includes(request.method || "GET")) return undefined;
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error("Solicitud demasiado grande");
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export function createMusicGatewayProxy({ baseUrl, timeoutMs = 90_000, fetchImpl = fetch } = {}) {
  const upstream = new URL(baseUrl);
  return async function proxyMusicGateway(request, response) {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    if (requestUrl.pathname !== PREFIX && !requestUrl.pathname.startsWith(`${PREFIX}/`)) return false;
    try {
      const suffix = requestUrl.pathname.slice(PREFIX.length) || "/";
      const target = new URL(`${suffix}${requestUrl.search}`, upstream);
      const headers = new Headers();
      for (const name of ["content-type", "x-satellite-id"]) {
        if (request.headers?.[name]) headers.set(name, request.headers[name]);
      }
      const result = await fetchImpl(target, {
        method: request.method,
        headers,
        body: await requestBody(request),
        signal: AbortSignal.timeout(timeoutMs)
      });
      response.statusCode = result.status;
      response.setHeader("Content-Type", result.headers.get("content-type") || "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.statusCode = error.message === "Solicitud demasiado grande" ? 413 : 502;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "music_gateway_unavailable", message: error.message }));
    }
    return true;
  };
}
