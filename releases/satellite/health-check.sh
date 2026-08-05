#!/bin/sh
set -eu

FAILED=0
check_service() {
  if systemctl is-active --quiet "$1"; then
    echo "OK  $1 activo"
  else
    echo "ERROR  $1 no está activo" >&2
    FAILED=1
  fi
}

check_service ha-display.service
check_service ha-satellite.service
if pgrep -x cog >/dev/null 2>&1; then
  echo "OK  Cog/WPE Kiosk activo"
else
  echo "ERROR  Cog/WPE Kiosk no está activo" >&2
  FAILED=1
fi

if curl -fsS http://127.0.0.1:8080/ >/dev/null 2>&1; then
  echo "OK  Display local"
else
  echo "ERROR  Display local no responde" >&2
  FAILED=1
fi
if curl -fsS http://127.0.0.1:3200/audio >/dev/null 2>&1; then
  echo "OK  API local del satélite"
else
  echo "ERROR  API local del satélite no responde" >&2
  FAILED=1
fi

for PATH_TO_CHECK in \
  /var/lib/ha/models/vosk-model-small-es-0.42 \
  /opt/ha/venvs/satellite/bin/python \
  /opt/ha/venvs/satellite/bin/piper \
  /opt/ha/tools/bin/sendspin; do
  if [ -e "$PATH_TO_CHECK" ]; then
    echo "OK  $PATH_TO_CHECK"
  else
    echo "ERROR  falta $PATH_TO_CHECK" >&2
    FAILED=1
  fi
done

PIPER_VOICE_COUNT=$(find /var/lib/ha/models/piper -type f -name 'es_*.onnx' | wc -l)
if [ "$PIPER_VOICE_COUNT" -ge 9 ]; then
  echo "OK  $PIPER_VOICE_COUNT voces Piper en español"
else
  echo "ERROR  sólo hay $PIPER_VOICE_COUNT voces Piper en español; se esperaban al menos 9" >&2
  FAILED=1
fi

if command -v vcgencmd >/dev/null 2>&1; then
  THROTTLED=$(vcgencmd get_throttled)
  echo "INFO  Energía: $THROTTLED"
  VALUE=${THROTTLED#*=}
  if [ $((VALUE & 1)) -ne 0 ]; then
    echo "ERROR  hay bajo voltaje activo" >&2
    FAILED=1
  fi
fi

exit "$FAILED"
