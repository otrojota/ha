#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
PID_FILE="$SCRIPT_DIR/.server.pid"
MUSIC_GATEWAY_PID_FILE="$SCRIPT_DIR/.music-gateway.pid"
OLLAMA_PID_FILE="$SCRIPT_DIR/.ollama.pid"
LOG_FILE="$SCRIPT_DIR/server.log"
MUSIC_GATEWAY_LOG="$SCRIPT_DIR/music-gateway.log"
OLLAMA_LOG="$SCRIPT_DIR/ollama.log"
SEARXNG_COMPOSE="$SCRIPT_DIR/searxng/compose.yml"

SERVER_ALREADY_RUNNING=false
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  SERVER_ALREADY_RUNNING=true
fi
MUSIC_GATEWAY_ALREADY_RUNNING=false
if [ -f "$MUSIC_GATEWAY_PID_FILE" ] && kill -0 "$(cat "$MUSIC_GATEWAY_PID_FILE")" 2>/dev/null; then
  MUSIC_GATEWAY_ALREADY_RUNNING=true
fi

set -a
. "$SCRIPT_DIR/.env"
if [ -f "$SCRIPT_DIR/.env.local" ]; then
  . "$SCRIPT_DIR/.env.local"
fi
set +a

cd "$REPO_ROOT"
if ! command -v ollama >/dev/null 2>&1; then
  echo "No se encontró ollama. Instálalo antes de iniciar el servidor."
  exit 1
fi
if ! curl -fsS "${OLLAMA_URL:-http://localhost:11434}/api/tags" >/dev/null 2>&1; then
  nohup ollama serve >>"$OLLAMA_LOG" 2>&1 &
  OLLAMA_PID=$!
  printf '%s\n' "$OLLAMA_PID" >"$OLLAMA_PID_FILE"
  WAIT=0
  while ! curl -fsS "${OLLAMA_URL:-http://localhost:11434}/api/tags" >/dev/null 2>&1 && [ "$WAIT" -lt 15 ]; do
    sleep 1
    WAIT=$((WAIT + 1))
  done
  if ! curl -fsS "${OLLAMA_URL:-http://localhost:11434}/api/tags" >/dev/null 2>&1; then
    echo "Ollama no pudo iniciarse. Revisa $OLLAMA_LOG"
    exit 1
  fi
  echo "Ollama iniciado (PID $OLLAMA_PID). Log: $OLLAMA_LOG"
else
  echo "Ollama ya está disponible; se reutilizará la instancia existente."
fi
if ! ollama show "${OLLAMA_MODEL:-qwen3.5:9b}" >/dev/null 2>&1; then
  echo "No se encontró el modelo Ollama ${OLLAMA_MODEL:-qwen3.5:9b}. Ejecuta: ollama pull ${OLLAMA_MODEL:-qwen3.5:9b}"
  exit 1
fi
if ! command -v "${WHISPER_CLI:-whisper-cli}" >/dev/null 2>&1; then
  echo "No se encontró ${WHISPER_CLI:-whisper-cli}. Instala whisper.cpp antes de iniciar el servidor."
  exit 1
fi
if [ -z "${WHISPER_MODEL_PATH:-}" ] || [ ! -f "$WHISPER_MODEL_PATH" ]; then
  echo "No se encontró el modelo Whisper configurado en WHISPER_MODEL_PATH=${WHISPER_MODEL_PATH:-}."
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "No se encontró Docker. Es necesario para iniciar SearXNG."
  exit 1
fi
docker compose -f "$SEARXNG_COMPOSE" up -d
WAIT=0
while ! curl -fsS "http://127.0.0.1:8888/search?q=prueba&format=json" >/dev/null 2>&1 && [ "$WAIT" -lt 30 ]; do
  sleep 1
  WAIT=$((WAIT + 1))
done
if ! curl -fsS "http://127.0.0.1:8888/search?q=prueba&format=json" >/dev/null 2>&1; then
  echo "SearXNG no pudo iniciarse. Revisa: docker compose -f $SEARXNG_COMPOSE logs"
  exit 1
fi
echo "SearXNG disponible en http://127.0.0.1:8888"
if [ "$MUSIC_GATEWAY_ALREADY_RUNNING" = true ] && find services/music-gateway/src -type f -newer "$MUSIC_GATEWAY_PID_FILE" -print -quit | grep -q .; then
  MUSIC_GATEWAY_PID=$(cat "$MUSIC_GATEWAY_PID_FILE")
  if kill -0 "$MUSIC_GATEWAY_PID" 2>/dev/null; then kill "$MUSIC_GATEWAY_PID"; fi
  rm -f "$MUSIC_GATEWAY_PID_FILE"
  MUSIC_GATEWAY_ALREADY_RUNNING=false
  echo "Music Gateway se reiniciará para aplicar cambios de código."
fi
if [ "$MUSIC_GATEWAY_ALREADY_RUNNING" = false ]; then
  nohup node services/music-gateway/src/index.js >>"$MUSIC_GATEWAY_LOG" 2>&1 &
  MUSIC_GATEWAY_PID=$!
  printf '%s\n' "$MUSIC_GATEWAY_PID" >"$MUSIC_GATEWAY_PID_FILE"
  WAIT=0
  while ! curl -fsS "http://127.0.0.1:${MUSIC_GATEWAY_PORT:-3100}/health" >/dev/null 2>&1 && [ "$WAIT" -lt 15 ]; do
    sleep 1
    WAIT=$((WAIT + 1))
  done
  if ! curl -fsS "http://127.0.0.1:${MUSIC_GATEWAY_PORT:-3100}/health" >/dev/null 2>&1; then
    if kill -0 "$MUSIC_GATEWAY_PID" 2>/dev/null; then kill "$MUSIC_GATEWAY_PID"; fi
    rm -f "$MUSIC_GATEWAY_PID_FILE"
    echo "Music Gateway no pudo iniciarse. Revisa $MUSIC_GATEWAY_LOG"
    exit 1
  fi
  echo "Music Gateway iniciado (PID $MUSIC_GATEWAY_PID). Log: $MUSIC_GATEWAY_LOG"
else
  echo "Music Gateway ya está ejecutándose (PID $(cat "$MUSIC_GATEWAY_PID_FILE"))."
fi
if [ "$SERVER_ALREADY_RUNNING" = true ]; then
  echo "El servidor ya está ejecutándose (PID $(cat "$PID_FILE")). Dependencias verificadas."
  exit 0
fi
nohup node apps/server/src/index.js >>"$LOG_FILE" 2>&1 &
PID=$!
printf '%s\n' "$PID" >"$PID_FILE"
sleep 1

if ! kill -0 "$PID" 2>/dev/null; then
  echo "El servidor no pudo iniciarse. Revisa $LOG_FILE"
  exit 1
fi

echo "Servidor iniciado (PID $PID). Log: $LOG_FILE"
