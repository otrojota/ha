#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT/releases/server/manifest.json').version")
ARCHIVE="$ROOT/releases/dist/ha-server-$VERSION-linux-arm64.tar.gz"
[ -f "$ARCHIVE" ] || { echo "No existe el release ARM64 $VERSION del servidor" >&2; exit 1; }
HASH=$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')

ssh ha-server 'mkdir -p /var/tmp/ha-deploy/server && chmod 700 /var/tmp/ha-deploy/server'
scp "$ARCHIVE" ha-server:/var/tmp/ha-deploy/server/release.tar.gz
printf '%s\n' "$HASH" | ssh ha-server 'umask 077; cat > /var/tmp/ha-deploy/server/release.sha256'
ssh ha-server 'sudo -n /usr/local/sbin/ha-deploy-server'
ssh ha-server 'i=0; while [ "$i" -lt 300 ]; do if systemctl is-active --quiet ha-containers ha-music-gateway ha-server && curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:3100/health >/dev/null 2>&1; then exit 0; fi; i=$((i + 1)); sleep 1; done; systemctl --no-pager --full status ha-containers ha-music-gateway ha-server; exit 1'
