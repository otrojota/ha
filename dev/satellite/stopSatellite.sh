#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

stop_process() {
  NAME=$1
  PID_FILE=$2
  if [ ! -f "$PID_FILE" ]; then
    echo "$NAME no está iniciado."
    return
  fi

  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    WAIT=0
    while kill -0 "$PID" 2>/dev/null && [ "$WAIT" -lt 10 ]; do
      sleep 1
      WAIT=$((WAIT + 1))
    done
  fi
  rm -f "$PID_FILE"
  echo "$NAME detenido."
}

stop_process "Display" "$SCRIPT_DIR/.display.pid"
stop_process "Satélite" "$SCRIPT_DIR/.satellite.pid"
