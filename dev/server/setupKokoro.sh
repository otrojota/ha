#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
VENV=${KOKORO_VENV:-$SCRIPT_DIR/.venv-kokoro}

if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "Kokoro en español requiere espeak-ng. En macOS: brew install espeak-ng" >&2
  exit 1
fi
if command -v python3.11 >/dev/null 2>&1; then
  BOOTSTRAP_PYTHON=python3.11
elif command -v python3 >/dev/null 2>&1; then
  BOOTSTRAP_PYTHON=python3
else
  echo "No se encontró Python 3.10 a 3.13." >&2
  exit 1
fi

if [ ! -x "$VENV/bin/python" ]; then
  # --clear también repara entornos que quedaron apuntando a una versión de
  # Python eliminada por Homebrew.
  "$BOOTSTRAP_PYTHON" -m venv --clear "$VENV"
fi
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -r "$REPO_ROOT/dev/server/requirements-kokoro.txt"

echo "Kokoro instalado en $VENV"
echo "El modelo y cada voz se descargarán a la caché durante su primer uso."
