#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
SATELLITE_PID_FILE="$SCRIPT_DIR/.satellite.pid"
DISPLAY_PID_FILE="$SCRIPT_DIR/.display.pid"
SATELLITE_LOG="$SCRIPT_DIR/satellite.log"
DISPLAY_LOG="$SCRIPT_DIR/display.log"

set -a
. "$SCRIPT_DIR/.env"
set +a

if [ "${WAKE_WORD_PROVIDER:-vosk}" = "vosk" ]; then
  cd "$REPO_ROOT"
  if [ ! -x "${VOSK_PYTHON:-dev/satellite/.venv/bin/python}" ]; then
    echo "No se encontró el entorno Python de Vosk en ${VOSK_PYTHON:-dev/satellite/.venv/bin/python}."
    exit 1
  fi
  if [ ! -d "${VOSK_MODEL_PATH:-dev/satellite/models/vosk-model-small-es-0.42}" ]; then
    echo "No se encontró el modelo Vosk en ${VOSK_MODEL_PATH:-dev/satellite/models/vosk-model-small-es-0.42}."
    exit 1
  fi
fi

start_process() {
  NAME=$1
  PID_FILE=$2
  LOG_FILE=$3
  shift 3

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "$NAME ya está ejecutándose (PID $(cat "$PID_FILE"))."
    return
  fi

  cd "$REPO_ROOT"
  nohup "$@" >>"$LOG_FILE" 2>&1 &
  PID=$!
  printf '%s\n' "$PID" >"$PID_FILE"
  sleep 1
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "$NAME no pudo iniciarse. Revisa $LOG_FILE"
    exit 1
  fi
  echo "$NAME iniciado (PID $PID). Log: $LOG_FILE"
}

start_process "Satélite" "$SATELLITE_PID_FILE" "$SATELLITE_LOG" node apps/satellite/src/index.js
start_process "Display" "$DISPLAY_PID_FILE" "$DISPLAY_LOG" "$REPO_ROOT/node_modules/.bin/serve" apps/display/public -l "${DISPLAY_PORT:-8080}"
