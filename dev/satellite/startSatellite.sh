#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SENDSPIN_PID_FILE="$SCRIPT_DIR/.sendspin.pid"
SENDSPIN_LOG="$SCRIPT_DIR/sendspin.log"

set -a
if [ -f /etc/ha/satellite.env ]; then
  . /etc/ha/satellite.env
elif [ -f "$SCRIPT_DIR/.env" ]; then
  . "$SCRIPT_DIR/.env"
fi
set +a

SENDSPIN_CLIENT_ID=${SENDSPIN_ID:-ha-${SATELLITE_ID:-$(hostname)}}
SENDSPIN_CLIENT_NAME=${SENDSPIN_NAME:-HA Satellite $(hostname)}
SENDSPIN_SETTINGS=${SENDSPIN_SETTINGS_DIR:-$SCRIPT_DIR/.sendspin}
SENDSPIN_LABEL_ID=$(printf '%s' "$SENDSPIN_CLIENT_ID" | tr -c 'A-Za-z0-9._-' '-')
SENDSPIN_LAUNCHD_LABEL=${SENDSPIN_LAUNCHD_LABEL:-com.ha.sendspin.$SENDSPIN_LABEL_ID}

ensure_sendspin() {
  CONFIGURED=${SENDSPIN_EXECUTABLE:-sendspin}
  if command -v "$CONFIGURED" >/dev/null 2>&1; then
    SENDSPIN_EXECUTABLE=$(command -v "$CONFIGURED")
    return
  fi
  if [ -x "$CONFIGURED" ]; then
    SENDSPIN_EXECUTABLE=$CONFIGURED
    return
  fi
  if [ "$CONFIGURED" != "sendspin" ]; then
    echo "No se encontró SENDSPIN_EXECUTABLE=$CONFIGURED."
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
      command -v curl >/dev/null 2>&1 || { echo "Se necesita curl para instalar uv y Sendspin."; exit 1; }
      echo "Instalando uv local…"
      UV_INSTALL_DIR="$TOOLS_BIN" UV_NO_MODIFY_PATH=1 sh -c "$(curl -LsSf https://astral.sh/uv/install.sh)"
      UV="$TOOLS_BIN/uv"
    fi
    echo "Instalando Sendspin local con Python 3.12…"
    UV_TOOL_BIN_DIR="$TOOLS_BIN" "$UV" tool install --python 3.12 sendspin
  fi
  [ -x "$SENDSPIN_LOCAL" ] || { echo "No se encontró $SENDSPIN_LOCAL después de instalar."; exit 1; }
  SENDSPIN_EXECUTABLE=$SENDSPIN_LOCAL
}

if [ "$(uname -s)" = Darwin ] && launchctl print "gui/$(id -u)/$SENDSPIN_LAUNCHD_LABEL" >/dev/null 2>&1; then
  echo "Sendspin ya está ejecutándose mediante launchd ($SENDSPIN_LAUNCHD_LABEL)."
  exit 0
fi

if [ -f "$SENDSPIN_PID_FILE" ]; then
  SENDSPIN_PID=$(cat "$SENDSPIN_PID_FILE")
  if kill -0 "$SENDSPIN_PID" 2>/dev/null; then
    echo "Sendspin ya está ejecutándose (PID $SENDSPIN_PID)."
    exit 0
  fi
  rm -f "$SENDSPIN_PID_FILE"
fi

ensure_sendspin

mkdir -p "$SENDSPIN_SETTINGS"

set -- "$SENDSPIN_EXECUTABLE" daemon \
  --id "$SENDSPIN_CLIENT_ID" \
  --name "$SENDSPIN_CLIENT_NAME" \
  --manufacturer "HA Voice Assistant" \
  --product-name "Satellite Speaker" \
  --settings-dir "$SENDSPIN_SETTINGS"

if [ -n "${MUSIC_ASSISTANT_SENDSPIN_URL:-}" ]; then
  set -- "$@" --url "$MUSIC_ASSISTANT_SENDSPIN_URL"
fi
if [ -n "${SENDSPIN_AUDIO_DEVICE:-}" ]; then
  set -- "$@" --audio-device "$SENDSPIN_AUDIO_DEVICE"
fi
if [ -n "${SENDSPIN_INTERFACE:-}" ]; then
  set -- "$@" --interface "$SENDSPIN_INTERFACE"
fi

if [ "$(uname -s)" = Darwin ]; then
  launchctl submit -l "$SENDSPIN_LAUNCHD_LABEL" -o "$SENDSPIN_LOG" -e "$SENDSPIN_LOG" -- "$@"
  sleep 1
  SENDSPIN_PID=$(launchctl print "gui/$(id -u)/$SENDSPIN_LAUNCHD_LABEL" \
    | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1)
  if [ -z "$SENDSPIN_PID" ]; then
    launchctl remove "$SENDSPIN_LAUNCHD_LABEL" 2>/dev/null || true
    echo "Sendspin no pudo iniciarse mediante launchd. Revisa $SENDSPIN_LOG"
    exit 1
  fi
else
  nohup "$@" >>"$SENDSPIN_LOG" 2>&1 &
  SENDSPIN_PID=$!
fi
printf '%s\n' "$SENDSPIN_PID" > "$SENDSPIN_PID_FILE"
sleep 1
if ! kill -0 "$SENDSPIN_PID" 2>/dev/null; then
  [ "$(uname -s)" != Darwin ] || launchctl remove "$SENDSPIN_LAUNCHD_LABEL" 2>/dev/null || true
  rm -f "$SENDSPIN_PID_FILE"
  echo "Sendspin no pudo iniciarse. Revisa $SENDSPIN_LOG"
  exit 1
fi

echo "Sendspin iniciado (PID $SENDSPIN_PID). Log: $SENDSPIN_LOG"
