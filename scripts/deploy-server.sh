#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
set -- "$ROOT"/releases/dist/ha-server-*-linux-arm64.tar.gz
[ "$#" -eq 1 ] && [ -f "$1" ] || { echo "Debe existir exactamente un release ARM64 del servidor" >&2; exit 1; }
ARCHIVE=$1
HASH=$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')

ssh ha-server 'mkdir -p /var/tmp/ha-deploy/server && chmod 700 /var/tmp/ha-deploy/server'
scp "$ARCHIVE" ha-server:/var/tmp/ha-deploy/server/release.tar.gz
printf '%s\n' "$HASH" | ssh ha-server 'umask 077; cat > /var/tmp/ha-deploy/server/release.sha256'
ssh ha-server 'sudo -n /usr/local/sbin/ha-deploy-server'
ssh ha-server 'i=0; while [ "$i" -lt 30 ]; do if systemctl is-active --quiet ha-containers ha-music-gateway ha-server && curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:3100/health >/dev/null 2>&1; then exit 0; fi; i=$((i + 1)); sleep 1; done; systemctl --no-pager --full status ha-containers ha-music-gateway ha-server; exit 1'
