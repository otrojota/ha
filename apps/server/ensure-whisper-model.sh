#!/bin/sh
set -eu

DEFAULT_MODEL_DIR=${1:-dev/server/models}
WHISPER_MODEL=${WHISPER_MODEL:-large-v3}
WHISPER_MODEL_DIR=${WHISPER_MODEL_DIR:-$DEFAULT_MODEL_DIR}

case "$WHISPER_MODEL" in
  ''|*[!A-Za-z0-9._-]*)
    echo "Nombre de modelo Whisper invalido: $WHISPER_MODEL" >&2
    exit 1
    ;;
esac

MODEL_PATH=${WHISPER_MODEL_PATH:-$WHISPER_MODEL_DIR/ggml-$WHISPER_MODEL.bin}
MODEL_URL=${WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$WHISPER_MODEL.bin}

if [ -s "$MODEL_PATH" ]; then
  echo "Modelo Whisper disponible: $MODEL_PATH"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "No se encontro curl para descargar el modelo Whisper $WHISPER_MODEL." >&2
  exit 1
fi

MODEL_PARENT=$(dirname -- "$MODEL_PATH")
mkdir -p "$MODEL_PARENT"
PART_PATH="$MODEL_PATH.part"

echo "Descargando modelo Whisper ${WHISPER_MODEL}…"
curl -fL -C - --retry 3 --retry-delay 2 "$MODEL_URL" -o "$PART_PATH"
if [ ! -s "$PART_PATH" ]; then
  echo "La descarga del modelo Whisper quedo vacia: $MODEL_URL" >&2
  exit 1
fi
mv -f -- "$PART_PATH" "$MODEL_PATH"
echo "Modelo Whisper instalado: $MODEL_PATH"
