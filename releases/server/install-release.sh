#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta este instalador como root." >&2
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(cat "$SOURCE_DIR/VERSION")
RELEASE_DIR="/opt/ha/releases/$VERSION"

for COMMAND in node npm docker curl; do
  if ! command -v "$COMMAND" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $COMMAND" >&2
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose no está disponible." >&2
  exit 1
fi

if ! id ha >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/ha --shell /usr/sbin/nologin ha
fi

mkdir -p /opt/ha/releases /etc/ha/server /var/lib/ha/models/whisper /var/lib/ha/music-assistant /var/lib/ha/home-assistant
if [ ! -d "$RELEASE_DIR" ]; then
  cp -R "$SOURCE_DIR" "$RELEASE_DIR"
fi

cd "$RELEASE_DIR"
npm ci --omit=dev

if [ ! -f /etc/ha/server.env ]; then
  install -m 0640 -o root -g ha deploy/server.env.example /etc/ha/server.env
fi
if grep -qx 'MUSIC_ASSISTANT_IMAGE=ghcr.io/music-assistant/server:2.8.8' /etc/ha/server.env; then
  sed -i 's|^MUSIC_ASSISTANT_IMAGE=ghcr.io/music-assistant/server:2.8.8$|MUSIC_ASSISTANT_IMAGE=ghcr.io/music-assistant/server:2.9.9|' /etc/ha/server.env
fi
if [ ! -f /etc/ha/server/music-assistant.env ]; then
  install -m 0600 -o ha -g ha /dev/null /etc/ha/server/music-assistant.env
fi
node "$RELEASE_DIR/migrate-config-v2.mjs" /etc/ha/server/music.json /etc/ha/server/server.json

chown -R root:root "$RELEASE_DIR"
# El wrapper puede ejecutarse desde una sesión con umask restrictiva. Asegura
# que los servicios sin privilegios puedan recorrer y leer el release.
chmod -R a+rX "$RELEASE_DIR"
chown -R ha:ha /etc/ha/server /var/lib/ha
ln -sfn "$RELEASE_DIR" /opt/ha/current

install -m 0644 deploy/systemd/ha-containers.service /etc/systemd/system/ha-containers.service
install -m 0644 deploy/systemd/ha-music-gateway.service /etc/systemd/system/ha-music-gateway.service
install -m 0644 deploy/systemd/ha-server.service /etc/systemd/system/ha-server.service
systemctl daemon-reload
systemctl enable ha-containers.service ha-music-gateway.service ha-server.service
systemctl restart ha-containers.service ha-music-gateway.service ha-server.service

# La instalación ya fue activada y los servicios levantaron correctamente.
# No se conservan releases anteriores para rollback.
for OLD_RELEASE in /opt/ha/releases/[0-9]*; do
  [ -d "$OLD_RELEASE" ] || continue
  [ "$OLD_RELEASE" = "$RELEASE_DIR" ] || rm -rf -- "$OLD_RELEASE"
done

echo "Release $VERSION instalada en $RELEASE_DIR"
echo "Configuración: /etc/ha/server.env y /etc/ha/server/"
echo "Pendiente: verifica Whisper y configura un proveedor LLM local o externo antes de usar el asistente."
