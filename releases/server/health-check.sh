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
TLS_HOST=${SERVER_TLS_HOST:-ha-server.local}
if [ -s /var/lib/ha/caddy-root.crt ]; then
  if curl --cacert /var/lib/ha/caddy-root.crt --resolve "$TLS_HOST:443:127.0.0.1" -fsS "https://$TLS_HOST/health" >/dev/null 2>&1; then
    echo "OK  HTTPS local (https://$TLS_HOST)"
  else
    echo "ERROR  HTTPS local no responde (https://$TLS_HOST)" >&2
    FAILED=1
  fi
else
  echo "ERROR  falta la CA local de Caddy: /var/lib/ha/caddy-root.crt" >&2
  FAILED=1
fi
check_url "Music Gateway" "http://127.0.0.1:${MUSIC_GATEWAY_PORT:-3100}/health"
if [ "${OLLAMA_LOCAL_ENABLED:-true}" = true ]; then
  check_url "Ollama" "${OLLAMA_URL:-http://127.0.0.1:11434}/api/tags"
else
  echo "OMITIDO  Ollama local deshabilitado; el proveedor LLM se configura desde el display"
fi
check_url "SearXNG" "http://127.0.0.1:8888/search?q=health&format=json"
check_url "Music Assistant" "${MUSIC_ASSISTANT_URL:-http://127.0.0.1:8095}/"
case ",${COMPOSE_PROFILES:-}," in
  *,home-assistant,*) check_url "Home Assistant" "http://127.0.0.1:8123/" ;;
esac

WHISPER_MODEL=${WHISPER_MODEL:-large-v3}
WHISPER_MODEL_DIR=${WHISPER_MODEL_DIR:-/var/lib/ha/models/whisper}
WHISPER_EFFECTIVE_MODEL_PATH=${WHISPER_MODEL_PATH:-$WHISPER_MODEL_DIR/ggml-$WHISPER_MODEL.bin}
if [ ! -s "$WHISPER_EFFECTIVE_MODEL_PATH" ]; then
  echo "ERROR  falta el modelo Whisper: $WHISPER_EFFECTIVE_MODEL_PATH" >&2
  FAILED=1
else
  echo "OK  Whisper $WHISPER_MODEL ($WHISPER_EFFECTIVE_MODEL_PATH)"
fi
if command -v "${WHISPER_SERVER_CLI:-whisper-server}" >/dev/null 2>&1; then
  echo "OK  whisper-server disponible"
else
  echo "ERROR  falta ${WHISPER_SERVER_CLI:-whisper-server}" >&2
  FAILED=1
fi

KOKORO_RUNTIME=${KOKORO_PYTHON:-/opt/ha/venvs/kokoro/bin/python}
if [ ! -x "$KOKORO_RUNTIME" ]; then
  echo "ERROR  falta el entorno Python de Kokoro" >&2
  FAILED=1
elif "$KOKORO_RUNTIME" -c 'import kokoro, torch' >/dev/null 2>&1; then
  echo "OK  Kokoro central disponible"
else
  echo "ERROR  Kokoro no puede importar sus dependencias" >&2
  FAILED=1
fi

exit "$FAILED"
