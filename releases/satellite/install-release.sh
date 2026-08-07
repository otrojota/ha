#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Ejecuta este instalador como root." >&2; exit 1; }

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(cat "$SOURCE_DIR/VERSION")
RELEASE_DIR="/opt/ha/releases/satellite-$VERSION"
SATELLITE_USER=${HA_SATELLITE_USER:-}

if [ -z "$SATELLITE_USER" ] || ! id "$SATELLITE_USER" >/dev/null 2>&1 || [ "$(id -u "$SATELLITE_USER")" -eq 0 ]; then
  echo "Define HA_SATELLITE_USER con el usuario normal que ejecutará audio y Chromium." >&2
  exit 1
fi
for COMMAND in chromium curl pgrep pkill runuser; do
  command -v "$COMMAND" >/dev/null 2>&1 || { echo "Falta el comando requerido: $COMMAND" >&2; exit 1; }
done

SATELLITE_UID=$(id -u "$SATELLITE_USER")
SATELLITE_GROUP=$(id -gn "$SATELLITE_USER")
SATELLITE_HOME=$(getent passwd "$SATELLITE_USER" | cut -d: -f6)

mkdir -p /opt/ha/releases /etc/ha /var/lib/ha/sendspin
if [ ! -d "$RELEASE_DIR" ]; then
  cp -R "$SOURCE_DIR" "$RELEASE_DIR"
fi

MIGRATED_SATELLITE_ID=
if [ -r /etc/ha/satellite.env ]; then
  MIGRATED_SATELLITE_ID=$(sed -n 's/^SATELLITE_ID=//p' /etc/ha/satellite.env | head -n 1)
fi
MIGRATED_SENDSPIN_NAME=${HA_SENDSPIN_NAME:-}
if [ -z "$MIGRATED_SENDSPIN_NAME" ] && [ -r /etc/ha/satellite/assistant.json ]; then
  MIGRATED_SENDSPIN_NAME=$(sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /etc/ha/satellite/assistant.json | head -n 1)
fi
if [ -f /etc/ha/satellite.env ] && grep -qE '^(DISPLAY_PORT|AUDIO_API_PORT|WAKE_WORD_PROVIDER|VOSK_|PIPER_)' /etc/ha/satellite.env; then
  install -d -m 0700 /var/lib/ha/deploy-backups
  install -m 0600 /etc/ha/satellite.env "/var/lib/ha/deploy-backups/satellite.env.before-$VERSION"
  rm -f /etc/ha/satellite.env
fi
if [ ! -f /etc/ha/satellite.env ]; then
  install -m 0640 -o root -g "$SATELLITE_GROUP" "$RELEASE_DIR/deploy/satellite.env.example" /etc/ha/satellite.env
  HOST_ID=$(hostname | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/^-*//; s/-*$//; s/--*/-/g')
  [ -n "$HOST_ID" ] || HOST_ID=$(cut -c 1-12 /etc/machine-id)
  GENERATED_SATELLITE_ID=${HA_SATELLITE_ID:-${MIGRATED_SATELLITE_ID:-satellite-$HOST_ID}}
  case "$GENERATED_SATELLITE_ID" in
    -*|*[!A-Za-z0-9._-]*|'') echo "Identificador de satélite inválido: $GENERATED_SATELLITE_ID" >&2; exit 1 ;;
  esac
  sed -i "s/^SATELLITE_ID=.*/SATELLITE_ID=$GENERATED_SATELLITE_ID/" /etc/ha/satellite.env
fi
if [ -n "$MIGRATED_SENDSPIN_NAME" ]; then
  case "$MIGRATED_SENDSPIN_NAME" in
    *"'"*|*"
"*) echo "El nombre Sendspin contiene caracteres no soportados." >&2; exit 1 ;;
  esac
  sed -i "s|^SENDSPIN_NAME=.*|SENDSPIN_NAME='$MIGRATED_SENDSPIN_NAME'|" /etc/ha/satellite.env
fi

for GROUP in audio video render input; do
  getent group "$GROUP" >/dev/null 2>&1 && usermod -a -G "$GROUP" "$SATELLITE_USER"
done
chown -R root:root "$RELEASE_DIR"
chmod -R a+rX "$RELEASE_DIR"
chown -R "$SATELLITE_USER:$SATELLITE_GROUP" /var/lib/ha/sendspin
install -d -m 0755 /etc/chromium/policies/managed
install -m 0644 "$RELEASE_DIR/deploy/chromium-policy.json" /etc/chromium/policies/managed/ha-satellite.json
ln -sfn "$RELEASE_DIR" /opt/ha/current

# Retira únicamente componentes conocidos de la arquitectura anterior. El
# satélite web ya no ejecuta Node, STT, wake word ni TTS local.
systemctl disable --now ha-display.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/ha-display.service
rm -rf /etc/ha/satellite /var/lib/ha/models /opt/ha/venvs
for OLD_PATH in /opt/ha/incomplete-satellite-* /opt/ha/releases/satellite-*; do
  [ -e "$OLD_PATH" ] || continue
  [ "$OLD_PATH" = "$RELEASE_DIR" ] || rm -rf "$OLD_PATH"
done

sed \
  -e "s/@@SATELLITE_USER@@/$SATELLITE_USER/g" \
  -e "s/@@SATELLITE_GROUP@@/$SATELLITE_GROUP/g" \
  -e "s/@@SATELLITE_UID@@/$SATELLITE_UID/g" \
  "$RELEASE_DIR/deploy/systemd/ha-satellite.service" >/etc/systemd/system/ha-satellite.service
chmod 0644 /etc/systemd/system/ha-satellite.service

mkdir -p "$SATELLITE_HOME/.config/labwc"
AUTOSTART="$SATELLITE_HOME/.config/labwc/autostart"
touch "$AUTOSTART"
sed -i '\|/opt/ha/current/deploy/kiosk-start\.sh|d; \|/opt/ha/current/deploy/kiosk-start-chromium\.sh|d; \|# HA Satellite kiosk|d; \|# HA Satellite web kiosk|d' "$AUTOSTART"
if ! grep -q '/opt/ha/current/deploy/kiosk-start-chromium.sh' "$AUTOSTART"; then
  printf '\n# HA Satellite web kiosk\n/opt/ha/current/deploy/kiosk-start-chromium.sh &\n' >>"$AUTOSTART"
fi
chown -R "$SATELLITE_USER:$SATELLITE_GROUP" "$SATELLITE_HOME/.config/labwc"

loginctl enable-linger "$SATELLITE_USER"
systemctl daemon-reload
systemctl enable ha-satellite.service
systemctl restart ha-satellite.service

RUNTIME_DIR="/run/user/$SATELLITE_UID"
WAYLAND_SOCKET=$(find "$RUNTIME_DIR" -maxdepth 1 -type s -name 'wayland-*' -print 2>/dev/null | head -n 1 || true)
if [ -n "$WAYLAND_SOCKET" ]; then
  pkill -TERM -u "$SATELLITE_UID" -x chromium 2>/dev/null || true
  KIOSK_LOG=/var/log/ha-kiosk.log
  touch "$KIOSK_LOG"
  chown "$SATELLITE_USER:$SATELLITE_GROUP" "$KIOSK_LOG"
  WAYLAND_DISPLAY=$(basename "$WAYLAND_SOCKET")
  runuser -u "$SATELLITE_USER" -- sh -c "HOME='$SATELLITE_HOME' XDG_RUNTIME_DIR='$RUNTIME_DIR' WAYLAND_DISPLAY='$WAYLAND_DISPLAY' DBUS_SESSION_BUS_ADDRESS='unix:path=$RUNTIME_DIR/bus' nohup /opt/ha/current/deploy/kiosk-start-chromium.sh >>'$KIOSK_LOG' 2>&1 </dev/null &" 9>&-
fi

echo "Release del satélite $VERSION instalada en $RELEASE_DIR"
echo "Configuración: /etc/ha/satellite.env"
