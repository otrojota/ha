#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PID_FILE="$SCRIPT_DIR/.server.pid"
MUSIC_GATEWAY_PID_FILE="$SCRIPT_DIR/.music-gateway.pid"
OLLAMA_PID_FILE="$SCRIPT_DIR/.ollama.pid"
SEARXNG_COMPOSE="$SCRIPT_DIR/searxng/compose.yml"
MUSIC_ASSISTANT_COMPOSE="$SCRIPT_DIR/music-assistant/compose.yml"
HOME_ASSISTANT_COMPOSE="$SCRIPT_DIR/home-assistant/compose.yml"

if [ -f "$PID_FILE" ]; then
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
  echo "Servidor detenido."
else
  echo "El servidor no está iniciado."
fi

if [ -f "$MUSIC_GATEWAY_PID_FILE" ]; then
  MUSIC_GATEWAY_PID=$(cat "$MUSIC_GATEWAY_PID_FILE")
  if kill -0 "$MUSIC_GATEWAY_PID" 2>/dev/null; then
    kill "$MUSIC_GATEWAY_PID"
    WAIT=0
    while kill -0 "$MUSIC_GATEWAY_PID" 2>/dev/null && [ "$WAIT" -lt 10 ]; do
      sleep 1
      WAIT=$((WAIT + 1))
    done
  fi
  rm -f "$MUSIC_GATEWAY_PID_FILE"
  echo "Music Gateway detenido."
else
  echo "Music Gateway no está iniciado."
fi

if [ -f "$OLLAMA_PID_FILE" ]; then
  OLLAMA_PID=$(cat "$OLLAMA_PID_FILE")
  if kill -0 "$OLLAMA_PID" 2>/dev/null; then
    kill "$OLLAMA_PID"
  fi
  rm -f "$OLLAMA_PID_FILE"
  echo "Ollama detenido (instancia iniciada por este entorno)."
fi

if command -v docker >/dev/null 2>&1; then
  docker compose -f "$SEARXNG_COMPOSE" down
  echo "SearXNG detenido."
  docker compose -f "$MUSIC_ASSISTANT_COMPOSE" down
  echo "Music Assistant detenido."
  docker compose -f "$HOME_ASSISTANT_COMPOSE" down
  echo "Home Assistant detenido."
fi
