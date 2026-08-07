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
MUSIC_ASSISTANT_COMPOSE="$SCRIPT_DIR/music-assistant/compose.yml"
MUSIC_ASSISTANT_MACOS_COMPOSE="$SCRIPT_DIR/music-assistant/compose.macos.yml"
HOME_ASSISTANT_COMPOSE="$SCRIPT_DIR/home-assistant/compose.yml"

music_assistant_compose() {
  if [ "$(uname -s)" = "Darwin" ]; then
    docker compose -f "$MUSIC_ASSISTANT_COMPOSE" -f "$MUSIC_ASSISTANT_MACOS_COMPOSE" "$@"
  else
    docker compose -f "$MUSIC_ASSISTANT_COMPOSE" "$@"
  fi
}

detect_macos_lan_ip() {
  DEFAULT_INTERFACE=$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')
  if [ -n "$DEFAULT_INTERFACE" ]; then
    ipconfig getifaddr "$DEFAULT_INTERFACE" 2>/dev/null || true
  fi
}

SERVER_ALREADY_RUNNING=false
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  SERVER_ALREADY_RUNNING=true
fi
MUSIC_GATEWAY_ALREADY_RUNNING=false
if [ -f "$MUSIC_GATEWAY_PID_FILE" ] && kill -0 "$(cat "$MUSIC_GATEWAY_PID_FILE")" 2>/dev/null; then
  MUSIC_GATEWAY_ALREADY_RUNNING=true
fi
MUSIC_GATEWAY_EXTERNAL_RUNNING=false

set -a
if [ -f /etc/ha/server.env ]; then
  . /etc/ha/server.env
else
  . "$SCRIPT_DIR/.env"
  if [ -f "$SCRIPT_DIR/.env.local" ]; then
    . "$SCRIPT_DIR/.env.local"
  fi
fi
if [ -f /etc/ha/server/music-assistant.env ]; then
  . /etc/ha/server/music-assistant.env
elif [ -f "$SCRIPT_DIR/.music-assistant.env" ]; then
  . "$SCRIPT_DIR/.music-assistant.env"
fi
set +a

cd "$REPO_ROOT"
if [ "${TTS_PROVIDER:-kokoro}" = kokoro ]; then
  KOKORO_PYTHON=${KOKORO_PYTHON:-dev/server/.venv-kokoro/bin/python}
  if [ ! -x "$KOKORO_PYTHON" ]; then
    echo "Preparando el entorno local de Kokoro…"
    KOKORO_VENV=$(dirname "$(dirname "$KOKORO_PYTHON")") "$SCRIPT_DIR/setupKokoro.sh"
  fi
  if ! "$KOKORO_PYTHON" -c 'import kokoro' >/dev/null 2>&1; then
    echo "El entorno de Kokoro está incompleto; reinstalando dependencias…"
    KOKORO_VENV=$(dirname "$(dirname "$KOKORO_PYTHON")") "$SCRIPT_DIR/setupKokoro.sh"
  fi
fi

if [ "$MUSIC_GATEWAY_ALREADY_RUNNING" = false ] && curl -fsS "http://127.0.0.1:${MUSIC_GATEWAY_PORT:-3100}/health" >/dev/null 2>&1; then
  MUSIC_GATEWAY_EXTERNAL_RUNNING=true
fi
SERVER_CONFIG_FILE=${SERVER_CONFIG_PATH:-$SCRIPT_DIR/config/server.json}
LLM_PROVIDER=$(node -e 'const fs=require("fs"); try { const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(c.llm?.provider||"ollama"); } catch { process.stdout.write("ollama"); }' "$SERVER_CONFIG_FILE")
OLLAMA_URL=$(node -e 'const fs=require("fs"); try { const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(c.llm?.baseUrl||process.argv[2]); } catch { process.stdout.write(process.argv[2]); }' "$SERVER_CONFIG_FILE" "${OLLAMA_URL:-http://127.0.0.1:11434}")
OLLAMA_MODEL=$(node -e 'const fs=require("fs"); try { const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(c.llm?.model||process.argv[2]); } catch { process.stdout.write(process.argv[2]); }' "$SERVER_CONFIG_FILE" "${OLLAMA_MODEL:-qwen3.5:9b}")
if [ "$LLM_PROVIDER" = "ollama" ]; then
OLLAMA_LOCAL=false
case "$OLLAMA_URL" in
  http://localhost:*|http://127.0.0.1:*|http://\[::1\]:*) OLLAMA_LOCAL=true ;;
esac
if ! curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1 && [ "$OLLAMA_LOCAL" = true ]; then
  if ! command -v ollama >/dev/null 2>&1; then
    echo "No se encontró Ollama local. Instálalo o configura OLLAMA_URL con un servidor remoto."
    exit 1
  fi
  nohup ollama serve >>"$OLLAMA_LOG" 2>&1 &
  OLLAMA_PID=$!
  printf '%s\n' "$OLLAMA_PID" >"$OLLAMA_PID_FILE"
  WAIT=0
  while ! curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1 && [ "$WAIT" -lt 15 ]; do
    sleep 1
    WAIT=$((WAIT + 1))
  done
  if ! curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    echo "Ollama no pudo iniciarse. Revisa $OLLAMA_LOG"
    exit 1
  fi
  echo "Ollama iniciado (PID $OLLAMA_PID). Log: $OLLAMA_LOG"
fi
if ! curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  echo "No se pudo conectar con Ollama en $OLLAMA_URL."
  echo "Si es remoto, permite conexiones de red en Ollama y revisa firewall, IP y puerto."
  exit 1
fi
echo "Ollama disponible en $OLLAMA_URL."
if ! curl -fsS -H 'Content-Type: application/json' -d "{\"model\":\"$OLLAMA_MODEL\"}" "$OLLAMA_URL/api/show" >/dev/null 2>&1; then
  echo "No se encontró el modelo $OLLAMA_MODEL en $OLLAMA_URL."
  echo "Instálalo en esa máquina con: ollama pull $OLLAMA_MODEL"
  exit 1
fi
else
  echo "Proveedor LLM externo configurado: $LLM_PROVIDER. Ollama no se iniciará."
fi
if ! command -v "${WHISPER_SERVER_CLI:-whisper-server}" >/dev/null 2>&1; then
  echo "No se encontró ${WHISPER_SERVER_CLI:-whisper-server}. Instala whisper.cpp con el target whisper-server antes de iniciar el servidor."
  exit 1
fi
WHISPER_MODEL=${WHISPER_MODEL:-large-v3}
WHISPER_MODEL_DIR=${WHISPER_MODEL_DIR:-$SCRIPT_DIR/models}
WHISPER_MODEL_PATH=${WHISPER_MODEL_PATH:-$WHISPER_MODEL_DIR/ggml-$WHISPER_MODEL.bin}
export WHISPER_MODEL WHISPER_MODEL_DIR WHISPER_MODEL_PATH
"$REPO_ROOT/apps/server/ensure-whisper-model.sh" "$SCRIPT_DIR/models"
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
HOME_ASSISTANT_ENABLED=$(node -e 'const fs=require("fs"); try { const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(c.homeAutomation?.homeAssistant?.enabled===true?"true":"false"); } catch { process.stdout.write("false"); }' "$SERVER_CONFIG_FILE")
if [ "$HOME_ASSISTANT_ENABLED" = "true" ]; then
docker compose -f "$HOME_ASSISTANT_COMPOSE" up -d
WAIT=0
while ! curl -fsS "${HOME_ASSISTANT_URL:-http://127.0.0.1:8123}/" >/dev/null 2>&1 && [ "$WAIT" -lt 120 ]; do
  sleep 1
  WAIT=$((WAIT + 1))
done
if ! curl -fsS "${HOME_ASSISTANT_URL:-http://127.0.0.1:8123}/" >/dev/null 2>&1; then
  echo "Home Assistant no pudo iniciarse en ${HOME_ASSISTANT_URL:-http://127.0.0.1:8123}."
  echo "Revisa: docker compose -f $HOME_ASSISTANT_COMPOSE logs"
  exit 1
fi
echo "Home Assistant disponible en ${HOME_ASSISTANT_URL:-http://127.0.0.1:8123}"
else
  echo "Home Assistant no está habilitado en la configuración del servidor; no se instalará ni iniciará."
fi
music_assistant_compose up -d
WAIT=0
MUSIC_ASSISTANT_STARTUP_TIMEOUT_SECONDS=${MUSIC_ASSISTANT_STARTUP_TIMEOUT_SECONDS:-30}
while ! curl -fsS "${MUSIC_ASSISTANT_URL:-http://127.0.0.1:8095}/" >/dev/null 2>&1 && [ "$WAIT" -lt "$MUSIC_ASSISTANT_STARTUP_TIMEOUT_SECONDS" ]; do
  sleep 1
  WAIT=$((WAIT + 1))
done
if ! curl -fsS "${MUSIC_ASSISTANT_URL:-http://127.0.0.1:8095}/" >/dev/null 2>&1; then
  echo "Advertencia: Music Assistant no está accesible en ${MUSIC_ASSISTANT_URL:-http://127.0.0.1:8095}."
  echo "Revisa: docker compose -f $MUSIC_ASSISTANT_COMPOSE logs"
  echo "El servidor continuará; las funciones que no dependen de música seguirán disponibles."
else
  echo "Music Assistant disponible en ${MUSIC_ASSISTANT_URL:-http://127.0.0.1:8095}"
  if [ "$(uname -s)" = "Darwin" ]; then
    MUSIC_ASSISTANT_EFFECTIVE_PUBLISH_IP=${MUSIC_ASSISTANT_PUBLISH_IP:-$(detect_macos_lan_ip)}
    if [ -n "$MUSIC_ASSISTANT_EFFECTIVE_PUBLISH_IP" ]; then
      MUSIC_ASSISTANT_CONFIG_BODY=$(node -e 'process.stdout.write(JSON.stringify({message_id:"dev-startup-streams",command:"config/core/save",args:{domain:"streams",values:{publish_ip:process.argv[1]}}}))' "$MUSIC_ASSISTANT_EFFECTIVE_PUBLISH_IP")
      if [ -n "${MUSIC_ASSISTANT_TOKEN:-}" ]; then
        MUSIC_ASSISTANT_CONFIG_RESPONSE=$(curl -sS -H 'Content-Type: application/json' -H "Authorization: Bearer $MUSIC_ASSISTANT_TOKEN" -d "$MUSIC_ASSISTANT_CONFIG_BODY" "${MUSIC_ASSISTANT_URL:-http://127.0.0.1:8095}/api" 2>/dev/null || true)
      else
        MUSIC_ASSISTANT_CONFIG_RESPONSE=$(curl -sS -H 'Content-Type: application/json' -d "$MUSIC_ASSISTANT_CONFIG_BODY" "${MUSIC_ASSISTANT_URL:-http://127.0.0.1:8095}/api" 2>/dev/null || true)
      fi
      if [ -z "$MUSIC_ASSISTANT_CONFIG_RESPONSE" ] || printf '%s' "$MUSIC_ASSISTANT_CONFIG_RESPONSE" | grep -q '"error_code"'; then
        echo "Advertencia: Music Assistant está accesible, pero no se pudo configurar su IP publicada en $MUSIC_ASSISTANT_EFFECTIVE_PUBLISH_IP."
      else
        echo "Music Assistant publicará streams mediante $MUSIC_ASSISTANT_EFFECTIVE_PUBLISH_IP:8097"
      fi
    else
      echo "Advertencia: no se pudo detectar la IP LAN del Mac para el streamserver de Music Assistant."
    fi
  fi
fi
if [ "$MUSIC_GATEWAY_ALREADY_RUNNING" = true ] && find services/music-gateway/src -type f -newer "$MUSIC_GATEWAY_PID_FILE" -print -quit | grep -q .; then
  MUSIC_GATEWAY_PID=$(cat "$MUSIC_GATEWAY_PID_FILE")
  if kill -0 "$MUSIC_GATEWAY_PID" 2>/dev/null; then kill "$MUSIC_GATEWAY_PID"; fi
  rm -f "$MUSIC_GATEWAY_PID_FILE"
  MUSIC_GATEWAY_ALREADY_RUNNING=false
  echo "Music Gateway se reiniciará para aplicar cambios de código."
fi
if [ "$MUSIC_GATEWAY_ALREADY_RUNNING" = false ] && [ "$MUSIC_GATEWAY_EXTERNAL_RUNNING" = false ]; then
  nohup node services/music-gateway/src/index.js >>"$MUSIC_GATEWAY_LOG" 2>&1 &
  MUSIC_GATEWAY_PID=$!
  printf '%s\n' "$MUSIC_GATEWAY_PID" >"$MUSIC_GATEWAY_PID_FILE"
  WAIT=0
  while ! curl -sS "http://127.0.0.1:${MUSIC_GATEWAY_PORT:-3100}/health" >/dev/null 2>&1 && [ "$WAIT" -lt 15 ]; do
    if ! kill -0 "$MUSIC_GATEWAY_PID" 2>/dev/null; then break; fi
    sleep 1
    WAIT=$((WAIT + 1))
  done
  if ! kill -0 "$MUSIC_GATEWAY_PID" 2>/dev/null; then
    rm -f "$MUSIC_GATEWAY_PID_FILE"
    echo "Music Gateway no pudo iniciar su proceso. Revisa $MUSIC_GATEWAY_LOG"
    exit 1
  fi
  HEALTH_RESPONSE=$(curl -sS "http://127.0.0.1:${MUSIC_GATEWAY_PORT:-3100}/health" 2>/dev/null || true)
  if ! printf '%s' "$HEALTH_RESPONSE" | grep -q '"connected":true'; then
    echo "Music Gateway inició, pero todavía no está autenticado con Music Assistant en ${MUSIC_ASSISTANT_URL:-http://127.0.0.1:8095}."
    if [ -n "$HEALTH_RESPONSE" ]; then
      printf 'Respuesta de diagnóstico: %s\n' "$HEALTH_RESPONSE"
    fi
    echo "El servidor continuará para permitir completar la autenticación desde el display del satélite."
  fi
  echo "Music Gateway iniciado (PID $MUSIC_GATEWAY_PID). Log: $MUSIC_GATEWAY_LOG"
elif [ "$MUSIC_GATEWAY_ALREADY_RUNNING" = true ]; then
  echo "Music Gateway ya está ejecutándose (PID $(cat "$MUSIC_GATEWAY_PID_FILE"))."
else
  echo "Music Gateway ya está disponible en http://127.0.0.1:${MUSIC_GATEWAY_PORT:-3100}; no se iniciará una segunda instancia."
fi
if [ "$SERVER_ALREADY_RUNNING" = true ] && {
  find apps/server/src apps/server/public -type f -newer "$PID_FILE" -print -quit 2>/dev/null | grep -q . \
    || [ apps/server/package.json -nt "$PID_FILE" ]
}; then
  SERVER_PID=$(cat "$PID_FILE")
  if kill -0 "$SERVER_PID" 2>/dev/null; then kill "$SERVER_PID"; fi
  rm -f "$PID_FILE"
  SERVER_ALREADY_RUNNING=false
  echo "El servidor se reiniciará para aplicar cambios de código o assets web."
fi
if [ "$SERVER_ALREADY_RUNNING" = true ]; then
  echo "El servidor ya está ejecutándose (PID $(cat "$PID_FILE")). Dependencias verificadas."
  exit 0
fi
nohup node apps/server/src/index.js >>"$LOG_FILE" 2>&1 &
PID=$!
printf '%s\n' "$PID" >"$PID_FILE"

WAIT=0
SERVER_STARTUP_TIMEOUT_SECONDS=${SERVER_STARTUP_TIMEOUT_SECONDS:-180}
while ! curl -fsS "http://127.0.0.1:${SERVER_PORT:-3000}/health" >/dev/null 2>&1 && [ "$WAIT" -lt "$SERVER_STARTUP_TIMEOUT_SECONDS" ]; do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "El servidor terminó durante la inicialización. Últimas líneas de $LOG_FILE:" >&2
    tail -n 30 "$LOG_FILE" >&2
    exit 1
  fi
  sleep 1
  WAIT=$((WAIT + 1))
done
if ! curl -fsS "http://127.0.0.1:${SERVER_PORT:-3000}/health" >/dev/null 2>&1; then
  kill "$PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "El servidor no respondió en el puerto ${SERVER_PORT:-3000} después de ${SERVER_STARTUP_TIMEOUT_SECONDS}s. Revisa $LOG_FILE" >&2
  exit 1
fi

echo "Servidor iniciado (PID $PID). Log: $LOG_FILE"
