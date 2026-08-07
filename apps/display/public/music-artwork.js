export function resolveMusicArtworkUrl(artworkPath, musicApiUrl) {
  const path = String(artworkPath || "").trim();
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (!musicApiUrl) return path;

  const apiUrl = new URL(musicApiUrl);
  if (path.startsWith("/")) {
    const versionedApi = apiUrl.pathname.match(/^(.*)\/v1\/?$/);
    const pathname = versionedApi && path.startsWith("/v1/")
      ? `${versionedApi[1]}${path}`
      : path;
    return new URL(pathname, apiUrl.origin).toString();
  }
  return new URL(path, `${apiUrl.toString().replace(/\/?$/, "/")}`).toString();
}
