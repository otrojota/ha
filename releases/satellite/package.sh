#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
VERSION=${1:-$(node -p "require('$SCRIPT_DIR/manifest.json').version")}

case "$VERSION" in
  ''|*[!0-9.]*|.*|*.) echo "Versión inválida: $VERSION" >&2; exit 1 ;;
esac

NAME="ha-satellite-$VERSION"
WORK_DIR="$REPO_ROOT/releases/work/$NAME"
DIST_DIR="$REPO_ROOT/releases/dist"
ARCHIVE="$DIST_DIR/$NAME-linux-arm64.tar.gz"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/deploy/systemd" "$DIST_DIR"
cp "$SCRIPT_DIR/config/satellite.env" "$WORK_DIR/deploy/satellite.env.example"
cp "$SCRIPT_DIR/config/chromium-policy.json" "$WORK_DIR/deploy/chromium-policy.json"
cp "$SCRIPT_DIR/systemd/ha-satellite.service" "$WORK_DIR/deploy/systemd/"
cp "$SCRIPT_DIR/start-sendspin.sh" "$SCRIPT_DIR/kiosk-start-chromium.sh" "$WORK_DIR/deploy/"
cp "$SCRIPT_DIR/install-release.sh" "$SCRIPT_DIR/health-check.sh" "$WORK_DIR/"
sed "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$SCRIPT_DIR/manifest.json" >"$WORK_DIR/release-manifest.json"
printf '%s\n' "$VERSION" >"$WORK_DIR/VERSION"

chmod +x "$WORK_DIR/install-release.sh" "$WORK_DIR/health-check.sh" \
  "$WORK_DIR/deploy/start-sendspin.sh" "$WORK_DIR/deploy/kiosk-start-chromium.sh"
tar -C "$(dirname "$WORK_DIR")" -czf "$ARCHIVE" "$NAME"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$DIST_DIR" && sha256sum "$(basename "$ARCHIVE")") >"$ARCHIVE.sha256"
else
  (cd "$DIST_DIR" && shasum -a 256 "$(basename "$ARCHIVE")") >"$ARCHIVE.sha256"
fi

echo "Artefacto creado: $ARCHIVE"
echo "Checksum: $ARCHIVE.sha256"
