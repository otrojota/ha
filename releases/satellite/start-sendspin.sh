#!/bin/sh
set -eu

if [ -f /etc/ha/satellite.env ]; then
  set -a
  . /etc/ha/satellite.env
  set +a
fi

SENDSPIN_EXECUTABLE=${SENDSPIN_EXECUTABLE:-/opt/ha/tools/bin/sendspin}
[ -x "$SENDSPIN_EXECUTABLE" ] || { echo "No se encontró Sendspin en $SENDSPIN_EXECUTABLE" >&2; exit 1; }

SENDSPIN_CLIENT_ID=${SENDSPIN_ID:-ha-${SATELLITE_ID:-$(hostname)}}
SENDSPIN_CLIENT_NAME=${SENDSPIN_NAME:-HA Satellite $(hostname)}
SENDSPIN_SETTINGS=${SENDSPIN_SETTINGS_DIR:-/var/lib/ha/sendspin}
mkdir -p "$SENDSPIN_SETTINGS"

set -- "$SENDSPIN_EXECUTABLE" daemon \
  --id "$SENDSPIN_CLIENT_ID" \
  --name "$SENDSPIN_CLIENT_NAME" \
  --manufacturer "HA Voice Assistant" \
  --product-name "Satellite Speaker" \
  --settings-dir "$SENDSPIN_SETTINGS"

[ -z "${MUSIC_ASSISTANT_SENDSPIN_URL:-}" ] || set -- "$@" --url "$MUSIC_ASSISTANT_SENDSPIN_URL"
[ -z "${SENDSPIN_AUDIO_DEVICE:-}" ] || set -- "$@" --audio-device "$SENDSPIN_AUDIO_DEVICE"
[ -z "${SENDSPIN_INTERFACE:-}" ] || set -- "$@" --interface "$SENDSPIN_INTERFACE"

exec "$@"
