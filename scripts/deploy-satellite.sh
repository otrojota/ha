#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HOST=${2:-ha-satellite}
case "$HOST" in
  -*|*[!A-Za-z0-9._-]*|'') echo "Host SSH de satélite inválido: $HOST" >&2; exit 1 ;;
esac

if [ "$#" -gt 2 ]; then
  echo "Uso: $0 [VERSION [HOST_SSH]]" >&2
  exit 1
fi

if [ "$#" -ge 1 ]; then
  VERSION=$1
  case "$VERSION" in *[!0-9.]*|'') echo "Versión de satélite inválida: $VERSION" >&2; exit 1 ;; esac
  ARCHIVE="$ROOT/releases/dist/ha-satellite-$VERSION-linux-arm64.tar.gz"
  [ -f "$ARCHIVE" ] || { echo "No existe el release del satélite $VERSION" >&2; exit 1; }
else
  set -- "$ROOT"/releases/dist/ha-satellite-*-linux-arm64.tar.gz
  [ "$#" -eq 1 ] && [ -f "$1" ] || { echo "Indica la versión cuando exista más de un release: $0 VERSION" >&2; exit 1; }
  ARCHIVE=$1
fi
HASH=$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')

ssh "$HOST" 'mkdir -p /var/tmp/ha-deploy/satellite && chmod 700 /var/tmp/ha-deploy/satellite'
scp "$ARCHIVE" "$HOST:/var/tmp/ha-deploy/satellite/release.tar.gz"
printf '%s\n' "$HASH" | ssh "$HOST" 'umask 077; cat > /var/tmp/ha-deploy/satellite/release.sha256'
ssh "$HOST" 'sudo -n /usr/local/sbin/ha-deploy-satellite'
ssh "$HOST" '/opt/ha/current/health-check.sh'
