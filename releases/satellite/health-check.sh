#!/bin/sh
set -eu

FAILED=0
if systemctl is-active --quiet ha-satellite.service; then
  echo "OK  Sendspin activo"
else
  echo "ERROR  ha-satellite.service no está activo" >&2
  FAILED=1
fi

if pgrep -x chromium >/dev/null 2>&1; then
  echo "OK  Chromium Kiosk activo"
else
  echo "ERROR  Chromium Kiosk no está activo" >&2
  FAILED=1
fi
if [ -r /etc/chromium/policies/managed/ha-satellite.json ] \
    && grep -q 'AudioCaptureAllowedUrls' /etc/chromium/policies/managed/ha-satellite.json; then
  echo "OK  Micrófono autorizado por política para el servidor"
else
  echo "ERROR  falta la política administrada de micrófono" >&2
  FAILED=1
fi

if [ -f /etc/ha/satellite.env ]; then
  set -a
  . /etc/ha/satellite.env
  set +a
fi
SERVER_URL=${SERVER_URL:-http://ha-server:3000}
if curl -fsS "$SERVER_URL/health" >/dev/null 2>&1; then
  echo "OK  Servidor accesible en $SERVER_URL"
else
  echo "ERROR  El servidor no responde en $SERVER_URL" >&2
  FAILED=1
fi

SENDSPIN_EXECUTABLE=${SENDSPIN_EXECUTABLE:-/opt/ha/tools/bin/sendspin}
if [ -x "$SENDSPIN_EXECUTABLE" ]; then
  echo "OK  $SENDSPIN_EXECUTABLE"
else
  echo "ERROR  falta $SENDSPIN_EXECUTABLE" >&2
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
