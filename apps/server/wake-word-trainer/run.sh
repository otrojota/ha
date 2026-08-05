#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)

if [ -n "${WAKE_WORD_TRAINER_RUNTIME_PATH:-}" ]; then
  RUNTIME_PATH=$WAKE_WORD_TRAINER_RUNTIME_PATH
elif [ -d /var/lib/ha ] && [ -w /var/lib/ha ]; then
  RUNTIME_PATH=/var/lib/ha/wake-word-trainer
else
  RUNTIME_PATH="$REPO_ROOT/dev/server/wake-word-trainer/.runtime"
fi

TOOLS_BIN="$RUNTIME_PATH/bin"
VENV="$RUNTIME_PATH/venv"
UV="$TOOLS_BIN/uv"
LOCK="$RUNTIME_PATH/install.lock"
mkdir -p "$TOOLS_BIN"

if command -v uv >/dev/null 2>&1; then
  UV=$(command -v uv)
elif [ ! -x "$UV" ]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "Se necesita curl para instalar el entorno aislado del entrenador." >&2
    exit 1
  fi
  echo "Instalando uv localmente para el entrenador…"
  UV_INSTALL_DIR="$TOOLS_BIN" UV_NO_MODIFY_PATH=1 sh -c "$(curl -LsSf https://astral.sh/uv/install.sh)"
fi

WAIT=0
while ! mkdir "$LOCK" 2>/dev/null; do
  if [ "$WAIT" -ge 300 ]; then
    echo "Otro proceso mantiene bloqueada la instalación del entrenador." >&2
    exit 1
  fi
  sleep 1
  WAIT=$((WAIT + 1))
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM

UV_PYTHON_INSTALL_DIR="$RUNTIME_PATH/python" "$UV" python install 3.11
VENV_RECREATED=0
if [ ! -x "$VENV/bin/python" ] || ! "$VENV/bin/python" -c 'import sys; raise SystemExit(sys.version_info[:2] != (3, 11))'; then
  UV_PYTHON_INSTALL_DIR="$RUNTIME_PATH/python" "$UV" venv --clear --python 3.11 "$VENV"
  VENV_RECREATED=1
fi

REQUIREMENTS_HASH=$(cksum "$SCRIPT_DIR/requirements.txt" | awk '{print $1 ":" $2}')
INSTALLED_HASH=$(sed -n '1p' "$RUNTIME_PATH/requirements.hash" 2>/dev/null || true)
if [ "$VENV_RECREATED" -eq 1 ] || [ "$REQUIREMENTS_HASH" != "$INSTALLED_HASH" ]; then
  echo "Instalando dependencias Python del entrenador…"
  "$UV" pip install --python "$VENV/bin/python" -r "$SCRIPT_DIR/requirements.txt"
  printf '%s\n' "$REQUIREMENTS_HASH" >"$RUNTIME_PATH/requirements.hash"
fi
rmdir "$LOCK"
trap - EXIT INT TERM

export WAKE_WORD_TRAINER_RUNTIME_PATH="$RUNTIME_PATH"
ENTRYPOINT=train.py
if [ "${1:-}" = "--evaluate" ]; then
  ENTRYPOINT=evaluate.py
  shift
fi
exec "$VENV/bin/python" "$SCRIPT_DIR/$ENTRYPOINT" "$@"
