#!/bin/sh
set -eu

ENV_FILE=${HA_ENV_FILE:-/etc/ha/server.env}
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

FAILED=0
check_url() {
  NAME=$1
  URL=$2
  if curl -fsS "$URL" >/dev/null 2>&1; then
    echo "OK  $NAME ($URL)"
  else
    echo "ERROR  $NAME no responde ($URL)" >&2
    FAILED=1
  fi
}

check_url "Servidor" "http://127.0.0.1:${SERVER_PORT:-3000}/health"
check_url "Music Gateway" "http://127.0.0.1:${MUSIC_GATEWAY_PORT:-3100}/health"
if [ "${OLLAMA_LOCAL_ENABLED:-true}" = true ]; then
  check_url "Ollama" "${OLLAMA_URL:-http://127.0.0.1:11434}/api/tags"
else
  echo "OMITIDO  Ollama local deshabilitado; el proveedor LLM se configura desde el display"
fi
check_url "SearXNG" "http://127.0.0.1:8888/search?q=health&format=json"
check_url "Music Assistant" "${MUSIC_ASSISTANT_URL:-http://127.0.0.1:8095}/"

if [ ! -f "${WHISPER_MODEL_PATH:-/var/lib/ha/models/whisper/ggml-small.bin}" ]; then
  echo "ERROR  falta el modelo Whisper: ${WHISPER_MODEL_PATH:-/var/lib/ha/models/whisper/ggml-small.bin}" >&2
  FAILED=1
fi

exit "$FAILED"
