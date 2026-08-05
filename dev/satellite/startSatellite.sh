#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
SATELLITE_PID_FILE="$SCRIPT_DIR/.satellite.pid"
DISPLAY_PID_FILE="$SCRIPT_DIR/.display.pid"
SATELLITE_LOG="$SCRIPT_DIR/satellite.log"
DISPLAY_LOG="$SCRIPT_DIR/display.log"

set -a
if [ -f /etc/ha/satellite.env ]; then
  . /etc/ha/satellite.env
else
  . "$SCRIPT_DIR/.env"
fi
set +a

ensure_sendspin() {
  CONFIGURED=${SENDSPIN_EXECUTABLE:-sendspin}
  if command -v "$CONFIGURED" >/dev/null 2>&1; then
    SENDSPIN_EXECUTABLE=$(command -v "$CONFIGURED")
    export SENDSPIN_EXECUTABLE
    return
  fi
  if [ "$CONFIGURED" != "sendspin" ]; then
    echo "No se encontró SENDSPIN_EXECUTABLE=$CONFIGURED. Corrige la ruta o usa SENDSPIN_EXECUTABLE=sendspin para instalarlo automáticamente."
    exit 1
  fi

  TOOLS_BIN="$SCRIPT_DIR/.tools/bin"
  SENDSPIN_LOCAL="$TOOLS_BIN/sendspin"
  if [ ! -x "$SENDSPIN_LOCAL" ]; then
    mkdir -p "$TOOLS_BIN"
    if command -v uv >/dev/null 2>&1; then
      UV=$(command -v uv)
    elif [ -x "$TOOLS_BIN/uv" ]; then
      UV="$TOOLS_BIN/uv"
    else
      if ! command -v curl >/dev/null 2>&1; then
        echo "Se necesita curl para instalar uv y Sendspin automáticamente."
        exit 1
      fi
      echo "uv no está instalado; instalando una copia local…"
      UV_INSTALL_DIR="$TOOLS_BIN" UV_NO_MODIFY_PATH=1 sh -c "$(curl -LsSf https://astral.sh/uv/install.sh)"
      UV="$TOOLS_BIN/uv"
    fi
    echo "Sendspin no está instalado; instalando una copia local con Python 3.12…"
    UV_TOOL_BIN_DIR="$TOOLS_BIN" "$UV" tool install --python 3.12 sendspin
  fi
  if [ ! -x "$SENDSPIN_LOCAL" ]; then
    echo "La instalación terminó, pero no se encontró $SENDSPIN_LOCAL."
    exit 1
  fi
  SENDSPIN_EXECUTABLE="$SENDSPIN_LOCAL"
  export SENDSPIN_EXECUTABLE
  echo "Sendspin disponible en $SENDSPIN_EXECUTABLE"
}

ensure_sendspin

ensure_openwakeword() {
  PYTHON=${OPENWAKEWORD_PYTHON:-${VOSK_PYTHON:-dev/satellite/.venv/bin/python}}
  case "$PYTHON" in
    /*) ;;
    *) PYTHON="$REPO_ROOT/$PYTHON" ;;
  esac
  if [ ! -x "$PYTHON" ]; then
    echo "No se encontró el entorno Python del detector en $PYTHON."
    exit 1
  fi
  if ! "$PYTHON" -c 'import numpy, onnxruntime, openwakeword' >/dev/null 2>&1; then
    echo "Instalando openWakeWord y ONNX Runtime en el entorno del satélite…"
    "$PYTHON" -m pip install -r "$REPO_ROOT/apps/satellite/requirements-wake-word.txt"
  fi
}

ensure_openwakeword

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
