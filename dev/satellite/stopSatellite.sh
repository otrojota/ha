#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SENDSPIN_PID_FILE="$SCRIPT_DIR/.sendspin.pid"

set -a
if [ -f /etc/ha/satellite.env ]; then
  . /etc/ha/satellite.env
elif [ -f "$SCRIPT_DIR/.env" ]; then
  . "$SCRIPT_DIR/.env"
fi
set +a

SENDSPIN_CLIENT_ID=${SENDSPIN_ID:-ha-${SATELLITE_ID:-$(hostname)}}
SENDSPIN_LABEL_ID=$(printf '%s' "$SENDSPIN_CLIENT_ID" | tr -c 'A-Za-z0-9._-' '-')
SENDSPIN_LAUNCHD_LABEL=${SENDSPIN_LAUNCHD_LABEL:-com.ha.sendspin.$SENDSPIN_LABEL_ID}

if [ "$(uname -s)" = Darwin ] && launchctl print "gui/$(id -u)/$SENDSPIN_LAUNCHD_LABEL" >/dev/null 2>&1; then
  launchctl remove "$SENDSPIN_LAUNCHD_LABEL"
  WAIT=0
  while launchctl print "gui/$(id -u)/$SENDSPIN_LAUNCHD_LABEL" >/dev/null 2>&1 && [ "$WAIT" -lt 10 ]; do
    sleep 1
    WAIT=$((WAIT + 1))
  done
  if launchctl print "gui/$(id -u)/$SENDSPIN_LAUNCHD_LABEL" >/dev/null 2>&1; then
    echo "Sendspin no terminó mediante launchd." >&2
    exit 1
  fi
  rm -f "$SENDSPIN_PID_FILE"
  echo "Sendspin detenido."
  exit 0
fi

if [ ! -f "$SENDSPIN_PID_FILE" ]; then
  echo "Sendspin no está iniciado."
  exit 0
fi

SENDSPIN_PID=$(cat "$SENDSPIN_PID_FILE")
if kill -0 "$SENDSPIN_PID" 2>/dev/null; then
  kill "$SENDSPIN_PID"
  WAIT=0
  while kill -0 "$SENDSPIN_PID" 2>/dev/null && [ "$WAIT" -lt 10 ]; do
    sleep 1
    WAIT=$((WAIT + 1))
  done
fi
rm -f "$SENDSPIN_PID_FILE"
echo "Sendspin detenido."
