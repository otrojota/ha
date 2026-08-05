#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta este instalador como root." >&2
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(cat "$SOURCE_DIR/VERSION")
RELEASE_DIR="/opt/ha/releases/satellite-$VERSION"
SATELLITE_USER=${HA_SATELLITE_USER:-}

if [ -z "$SATELLITE_USER" ] || ! id "$SATELLITE_USER" >/dev/null 2>&1; then
  echo "Define HA_SATELLITE_USER con el usuario normal que ejecutará audio y el kiosco." >&2
  exit 1
fi
if [ "$(id -u "$SATELLITE_USER")" -eq 0 ]; then
  echo "El satélite no debe ejecutarse como root." >&2
  exit 1
fi

for COMMAND in node npm ffmpeg pactl pw-play cog pgrep pkill runuser; do
  if ! command -v "$COMMAND" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $COMMAND" >&2
    exit 1
  fi
done

SATELLITE_UID=$(id -u "$SATELLITE_USER")
SATELLITE_GROUP=$(id -gn "$SATELLITE_USER")
SATELLITE_HOME=$(getent passwd "$SATELLITE_USER" | cut -d: -f6)

mkdir -p /opt/ha/releases /etc/ha/satellite /var/lib/ha/models/piper /var/lib/ha/models/wake-word
if [ ! -d "$RELEASE_DIR" ]; then
  cp -R "$SOURCE_DIR" "$RELEASE_DIR"
fi

cd "$RELEASE_DIR"
npm ci --omit=dev
/opt/ha/venvs/satellite/bin/pip install \
  -r "$RELEASE_DIR/apps/satellite/requirements-wake-word.txt"
/opt/ha/venvs/satellite/bin/pip install --no-deps 'openwakeword==0.6.0'

if [ ! -f /etc/ha/satellite.env ]; then
  install -m 0640 -o root -g "$SATELLITE_GROUP" deploy/satellite.env.example /etc/ha/satellite.env
  HOST_ID=$(hostname | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/^-*//; s/-*$//; s/--*/-/g')
  if [ -z "$HOST_ID" ]; then
    HOST_ID=$(cut -c 1-12 /etc/machine-id)
  fi
  GENERATED_SATELLITE_ID=${HA_SATELLITE_ID:-satellite-$HOST_ID}
  case "$GENERATED_SATELLITE_ID" in
    -*|*[!A-Za-z0-9._-]*|'') echo "Identificador de satélite inválido: $GENERATED_SATELLITE_ID" >&2; exit 1 ;;
  esac
  sed -i "s/^SATELLITE_ID=.*/SATELLITE_ID=$GENERATED_SATELLITE_ID/" /etc/ha/satellite.env
fi
node "$RELEASE_DIR/migrate-config-v2.mjs" /etc/ha/satellite/audio.json /etc/ha/satellite/server.json

for GROUP in audio video render input; do
  if getent group "$GROUP" >/dev/null 2>&1; then
    usermod -a -G "$GROUP" "$SATELLITE_USER"
  fi
done

chown -R root:root "$RELEASE_DIR"
chown -R "$SATELLITE_USER:$SATELLITE_GROUP" /etc/ha/satellite /var/lib/ha/models/piper /var/lib/ha/models/wake-word
ln -sfn "$RELEASE_DIR" /opt/ha/current

sed \
  -e "s/@@SATELLITE_USER@@/$SATELLITE_USER/g" \
  -e "s/@@SATELLITE_GROUP@@/$SATELLITE_GROUP/g" \
  -e "s/@@SATELLITE_UID@@/$SATELLITE_UID/g" \
  deploy/systemd/ha-display.service >/etc/systemd/system/ha-display.service
sed \
  -e "s/@@SATELLITE_USER@@/$SATELLITE_USER/g" \
  -e "s/@@SATELLITE_GROUP@@/$SATELLITE_GROUP/g" \
  -e "s/@@SATELLITE_UID@@/$SATELLITE_UID/g" \
  deploy/systemd/ha-satellite.service >/etc/systemd/system/ha-satellite.service
for OBSOLETE_EMEET_UNIT in \
  ha-emeet-audio-init.timer \
  ha-emeet-audio-init.path \
  ha-emeet-audio-init.service \
  ha-emeet-audio-save.service; do
  systemctl disable --now "$OBSOLETE_EMEET_UNIT" 2>/dev/null || true
done
rm -f /etc/systemd/system/ha-emeet-audio-init.timer \
  /etc/systemd/system/ha-emeet-audio-init.path \
  /etc/systemd/system/ha-emeet-audio-init.service \
  /etc/systemd/system/ha-emeet-audio-save.service \
  /var/lib/ha/emeet-volume
chmod 0644 /etc/systemd/system/ha-display.service /etc/systemd/system/ha-satellite.service

mkdir -p "$SATELLITE_HOME/.config/labwc"
AUTOSTART="$SATELLITE_HOME/.config/labwc/autostart"
touch "$AUTOSTART"
if grep -q '/opt/ha/current/deploy/kiosk-start.sh' "$AUTOSTART"; then
  echo "El autostart administrado del kiosco ya existe."
elif grep -q 'localhost:8080' "$AUTOSTART"; then
  echo "Se conservó el comando de kiosco existente para localhost:8080."
else
  printf '\n# HA Satellite kiosk\n/opt/ha/current/deploy/kiosk-start.sh &\n' >>"$AUTOSTART"
fi
chown -R "$SATELLITE_USER:$SATELLITE_GROUP" "$SATELLITE_HOME/.config/labwc"

loginctl enable-linger "$SATELLITE_USER"
systemctl daemon-reload
systemctl enable ha-display.service ha-satellite.service
systemctl restart ha-display.service ha-satellite.service

# Cog no pertenece a ha-display.service: Labwc lo inicia desde su autostart. En
# una actualización terminamos únicamente el navegador del usuario del satélite
# usuario del satélite y relanzamos el mismo script de kiosco contra el release
# que acaba de quedar activo. Esto evita reiniciar toda la Raspberry.
RUNTIME_DIR="/run/user/$SATELLITE_UID"
WAYLAND_SOCKET=$(find "$RUNTIME_DIR" -maxdepth 1 -type s -name 'wayland-*' -print 2>/dev/null | head -n 1 || true)
if [ -n "$WAYLAND_SOCKET" ]; then
  pkill -TERM -u "$SATELLITE_UID" -x cog 2>/dev/null || true
  pkill -TERM -u "$SATELLITE_UID" -x chromium 2>/dev/null || true
  WAIT_COUNT=0
  while { pgrep -u "$SATELLITE_UID" -x cog >/dev/null 2>&1 || pgrep -u "$SATELLITE_UID" -x chromium >/dev/null 2>&1; } && [ "$WAIT_COUNT" -lt 20 ]; do
    sleep 0.25
    WAIT_COUNT=$((WAIT_COUNT + 1))
  done
  if pgrep -u "$SATELLITE_UID" -x cog >/dev/null 2>&1; then
    pkill -KILL -u "$SATELLITE_UID" -x cog 2>/dev/null || true
  fi
  if pgrep -u "$SATELLITE_UID" -x chromium >/dev/null 2>&1; then
    pkill -KILL -u "$SATELLITE_UID" -x chromium 2>/dev/null || true
  fi
  KIOSK_LOG="/var/log/ha-kiosk.log"
  touch "$KIOSK_LOG"
  chown "$SATELLITE_USER:$SATELLITE_GROUP" "$KIOSK_LOG"
  WAYLAND_DISPLAY=$(basename "$WAYLAND_SOCKET")
  # Cierra el descriptor 9 usado por flock en el wrapper de despliegue. Sin
  # esto el navegador lo hereda y mantiene el bloqueo incluso tras terminar la
  # instalación.
  runuser -u "$SATELLITE_USER" -- sh -c "HOME='$SATELLITE_HOME' XDG_RUNTIME_DIR='$RUNTIME_DIR' WAYLAND_DISPLAY='$WAYLAND_DISPLAY' DBUS_SESSION_BUS_ADDRESS='unix:path=$RUNTIME_DIR/bus' nohup /opt/ha/current/deploy/kiosk-start.sh >>'$KIOSK_LOG' 2>&1 </dev/null &" 9>&-
  sleep 2
  if pgrep -u "$SATELLITE_UID" -x cog >/dev/null 2>&1; then
    echo "Cog/WPE Kiosk reiniciado sin reiniciar el equipo."
  else
    echo "No se pudo relanzar Cog/WPE Kiosk; revisa $KIOSK_LOG" >&2
    exit 1
  fi
else
  echo "No hay una sesión Wayland activa; Cog/WPE se iniciará en el próximo acceso o reinicio."
fi

# La instalación ya fue activada y los servicios (y, cuando corresponde, el
# kiosco) levantaron correctamente. No se conservan releases para rollback.
for OLD_RELEASE in /opt/ha/releases/satellite-*; do
  [ -d "$OLD_RELEASE" ] || continue
  [ "$OLD_RELEASE" = "$RELEASE_DIR" ] || rm -rf -- "$OLD_RELEASE"
done

echo "Release del satélite $VERSION instalada en $RELEASE_DIR"
echo "Usuario de audio y kiosco: $SATELLITE_USER"
echo "Configuración: /etc/ha/satellite.env y /etc/ha/satellite/"
echo "Display: http://localhost:8080"
