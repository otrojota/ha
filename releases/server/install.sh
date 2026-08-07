#!/bin/sh
set -eu

REPOSITORY=${HA_GITHUB_REPOSITORY:-otrojota/ha}
RELEASE_VERSION=${HA_VERSION:-0.1.58}
NODE_MIN=20.19.0
DOCKER_MIN=27.0.0
OLLAMA_MIN=0.32.0
WHISPER_VERSION=1.9.2
OLLAMA_MODEL=${OLLAMA_MODEL:-qwen3.5:9b}
WHISPER_MODEL=${WHISPER_MODEL:-large-v3}
WHISPER_MODEL_DIR=${WHISPER_MODEL_DIR:-/var/lib/ha/models/whisper}
WHISPER_CONFIGURED_MODEL_PATH=${WHISPER_MODEL_PATH:-}
WHISPER_MODEL_PATH=${WHISPER_CONFIGURED_MODEL_PATH:-$WHISPER_MODEL_DIR/ggml-$WHISPER_MODEL.bin}
WHISPER_CONFIGURED_MODEL_URL=${WHISPER_MODEL_URL:-}
WHISPER_MODEL_URL=${WHISPER_CONFIGURED_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$WHISPER_MODEL.bin}

case "$WHISPER_MODEL" in
  ''|*[!A-Za-z0-9._-]*) echo "Nombre de modelo Whisper inválido: $WHISPER_MODEL" >&2; exit 1 ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta el instalador como root: curl ... | sudo sh" >&2
  exit 1
fi
if [ ! -r /etc/os-release ]; then
  echo "No se pudo identificar el sistema operativo." >&2
  exit 1
fi

. /etc/os-release
IS_FEDORA=false
IS_RASPBERRY_PI_OS=false
if [ "${ID:-}" = fedora ] || [ "${ID:-}" = fedora-asahi-remix ]; then
  IS_FEDORA=true
else
  case " ${ID_LIKE:-} " in
    *" fedora "*) IS_FEDORA=true ;;
  esac
fi
if [ "${ID:-}" = raspbian ]; then
  IS_RASPBERRY_PI_OS=true
elif [ "${ID:-}" = debian ] && [ -r /proc/device-tree/model ] && grep -qi 'Raspberry Pi' /proc/device-tree/model; then
  IS_RASPBERRY_PI_OS=true
fi
if [ "$IS_FEDORA" != true ] && [ "$IS_RASPBERRY_PI_OS" != true ]; then
  echo "Este instalador soporta Fedora y Raspberry Pi OS Lite. Sistema detectado: ${ID:-desconocido}" >&2
  exit 1
fi

ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) RELEASE_ARCH=x64 ;;
  aarch64|arm64) RELEASE_ARCH=arm64 ;;
  armv7l) echo "Raspberry Pi OS de 32 bits no está soportado. Instala Raspberry Pi OS Lite de 64 bits." >&2; exit 1 ;;
  *) echo "Arquitectura no soportada: $ARCH" >&2; exit 1 ;;
esac

if [ "$IS_RASPBERRY_PI_OS" = true ]; then
  FLAVOR="Raspberry Pi OS Lite"
else
  FLAVOR="Fedora estándar"
  if [ "${ID:-}" = fedora-asahi-remix ] || { [ -r /proc/device-tree/compatible ] && tr '\000' '\n' </proc/device-tree/compatible | grep -qi apple; }; then
    FLAVOR="Fedora Asahi Remix"
  fi
fi
echo "Sistema detectado: $FLAVOR ${VERSION_ID:-} ($ARCH)"

version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

require_minimum() {
  NAME=$1
  CURRENT=$2
  MINIMUM=$3
  if ! version_ge "$CURRENT" "$MINIMUM"; then
    echo "$NAME $CURRENT está instalado, pero se requiere al menos $MINIMUM." >&2
    echo "No se actualizará automáticamente. Actualízalo y vuelve a ejecutar el instalador." >&2
    exit 1
  fi
  echo "$NAME $CURRENT: compatible"
}

if [ "$IS_FEDORA" = true ]; then
  echo "Instalando herramientas base de Fedora…"
  dnf install -y curl ca-certificates tar zstd git cmake gcc gcc-c++ make findutils pkgconf-pkg-config python3 python3-pip
else
  echo "Instalando herramientas base de Raspberry Pi OS Lite…"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates tar zstd git cmake gcc g++ make findutils gnupg python3 python3-pip python3-venv
fi

WHISPER_CMAKE_GPU_ARG=
WHISPER_GPU_BACKEND=cpu
if [ "$IS_FEDORA" = true ]; then
  echo "Comprobando soporte Vulkan para Whisper…"
  if dnf install -y mesa-vulkan-drivers vulkan-loader vulkan-loader-devel vulkan-headers vulkan-tools glslc spirv-headers-devel >/dev/null 2>&1 \
      && vulkaninfo --summary >/dev/null 2>&1; then
    WHISPER_CMAKE_GPU_ARG=-DGGML_VULKAN=ON
    WHISPER_GPU_BACKEND=vulkan
    echo "GPU Vulkan detectada; whisper.cpp se compilará con aceleración."
  else
    echo "No hay una GPU Vulkan utilizable; whisper.cpp usará CPU."
  fi
fi
WHISPER_SERVER_INSTALL_TARGET=/usr/local/bin/whisper-server
WHISPER_CLI_INSTALL_TARGET=/usr/local/bin/whisper-cli
if [ "$WHISPER_GPU_BACKEND" = vulkan ]; then
  WHISPER_SERVER_INSTALL_TARGET=/usr/local/bin/whisper-server-vulkan
  WHISPER_CLI_INSTALL_TARGET=/usr/local/bin/whisper-cli-vulkan
fi

if command -v node >/dev/null 2>&1; then
  require_minimum Node "$(node --version | sed 's/^v//')" "$NODE_MIN"
else
  if [ "$IS_FEDORA" = true ]; then
    dnf install -y nodejs npm
  else
    echo "Instalando Node.js 20 para Raspberry Pi OS…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sh
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi
  require_minimum Node "$(node --version | sed 's/^v//')" "$NODE_MIN"
fi

if command -v docker >/dev/null 2>&1; then
  DOCKER_VERSION=$(docker version --format '{{.Client.Version}}' 2>/dev/null || docker --version | sed -n 's/.*version \([0-9][0-9.]*\).*/\1/p')
  require_minimum Docker "$DOCKER_VERSION" "$DOCKER_MIN"
else
  echo "Instalando Docker Engine desde el repositorio oficial…"
  if [ "$IS_FEDORA" = true ]; then
    dnf install -y dnf-plugins-core
    dnf config-manager addrepo --from-repofile https://download.docker.com/linux/fedora/docker-ce.repo
    dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    curl -fsSL https://get.docker.com | sh
  fi
fi
systemctl enable --now docker
docker compose version >/dev/null

ask_boolean() {
  VARIABLE_NAME=$1
  PROMPT=$2
  VALUE=$3
  if [ -z "$VALUE" ]; then
    if [ -r /dev/tty ]; then
      printf '%s [s/N]: ' "$PROMPT" >/dev/tty
      IFS= read -r VALUE </dev/tty
    else
      echo "No hay una terminal interactiva. Define $VARIABLE_NAME=yes o $VARIABLE_NAME=no." >&2
      exit 1
    fi
  fi
  case "$VALUE" in
    s|S|si|Si|SI|sí|Sí|SÍ|y|Y|yes|YES|Yes) printf 'true' ;;
    n|N|no|NO|No|'') printf 'false' ;;
    *) echo "Respuesta inválida para $VARIABLE_NAME: $VALUE" >&2; exit 1 ;;
  esac
}

INSTALL_OLLAMA=$(ask_boolean HA_INSTALL_OLLAMA '¿Deseas instalar y usar Ollama local en este servidor?' "${HA_INSTALL_OLLAMA:-}")
INSTALL_HOME_ASSISTANT=$(ask_boolean HA_INSTALL_HOME_ASSISTANT '¿Deseas instalar y usar Home Assistant en este servidor?' "${HA_INSTALL_HOME_ASSISTANT:-}")

if [ "$INSTALL_OLLAMA" = true ]; then
  if command -v ollama >/dev/null 2>&1; then
    OLLAMA_VERSION=$(ollama --version 2>&1 | sed -n 's/.*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | tail -n 1)
    require_minimum Ollama "$OLLAMA_VERSION" "$OLLAMA_MIN"
  else
    echo "Instalando Ollama para ${ARCH}…"
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  systemctl enable --now ollama
else
  echo "Ollama local no se instalará ni se modificará. Configura el proveedor LLM externo desde el display."
fi

install_whisper() {
  echo "Compilando whisper.cpp $WHISPER_VERSION de forma nativa (backend: $WHISPER_GPU_BACKEND)…"
  WHISPER_WORK=$(mktemp -d)
  curl -fsSL "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v$WHISPER_VERSION.tar.gz" -o "$WHISPER_WORK/whisper.tar.gz"
  tar -xzf "$WHISPER_WORK/whisper.tar.gz" -C "$WHISPER_WORK"
  cmake -S "$WHISPER_WORK/whisper.cpp-$WHISPER_VERSION" -B "$WHISPER_WORK/build" -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DBUILD_SHARED_LIBS=OFF $WHISPER_CMAKE_GPU_ARG
  cmake --build "$WHISPER_WORK/build" --config Release --target whisper-cli whisper-server -j "$(nproc)"
  install -m 0755 "$WHISPER_WORK/build/bin/whisper-cli" "$WHISPER_CLI_INSTALL_TARGET"
  install -m 0755 "$WHISPER_WORK/build/bin/whisper-server" "$WHISPER_SERVER_INSTALL_TARGET"
  mkdir -p /usr/local/share/ha
  printf '%s %s\n' "$WHISPER_VERSION" "$WHISPER_GPU_BACKEND" >/usr/local/share/ha/whisper-build
  rm -rf "$WHISPER_WORK"
}

WHISPER_BUILD_STAMP="$WHISPER_VERSION $WHISPER_GPU_BACKEND"
if [ ! -x "$WHISPER_CLI_INSTALL_TARGET" ] \
    || [ ! -x "$WHISPER_SERVER_INSTALL_TARGET" ] \
    || [ ! -r /usr/local/share/ha/whisper-build ] \
    || [ "$(cat /usr/local/share/ha/whisper-build 2>/dev/null || true)" != "$WHISPER_BUILD_STAMP" ]; then
  install_whisper
fi

if ! "$WHISPER_SERVER_INSTALL_TARGET" --help >/dev/null 2>&1; then
  echo "whisper-server no puede ejecutarse después de compilarlo." >&2
  exit 1
fi
echo "whisper.cpp $WHISPER_VERSION ($WHISPER_GPU_BACKEND): compatible"

mkdir -p "$(dirname -- "$WHISPER_MODEL_PATH")"
if [ ! -s "$WHISPER_MODEL_PATH" ]; then
  echo "Descargando modelo Whisper ${WHISPER_MODEL}…"
  curl -fL --retry 3 --retry-delay 2 "$WHISPER_MODEL_URL" -o "$WHISPER_MODEL_PATH.part"
  test -s "$WHISPER_MODEL_PATH.part"
  mv "$WHISPER_MODEL_PATH.part" "$WHISPER_MODEL_PATH"
fi

if [ "$INSTALL_OLLAMA" = true ]; then
  echo "Descargando modelo Ollama ${OLLAMA_MODEL}…"
  ollama pull "$OLLAMA_MODEL"
fi

ARCHIVE="ha-server-$RELEASE_VERSION-linux-$RELEASE_ARCH.tar.gz"
DOWNLOAD_BASE="https://github.com/$REPOSITORY/releases/download/v$RELEASE_VERSION"
DOWNLOAD_DIR=$(mktemp -d)
if [ -n "${HA_RELEASE_ARCHIVE:-}" ]; then
  ARCHIVE=$(basename "$HA_RELEASE_ARCHIVE")
  cp "$HA_RELEASE_ARCHIVE" "$DOWNLOAD_DIR/$ARCHIVE"
else
  echo "Descargando release ${RELEASE_VERSION}…"
  curl -fL "$DOWNLOAD_BASE/$ARCHIVE" -o "$DOWNLOAD_DIR/$ARCHIVE"
  curl -fL "$DOWNLOAD_BASE/$ARCHIVE.sha256" -o "$DOWNLOAD_DIR/$ARCHIVE.sha256"
  (cd "$DOWNLOAD_DIR" && sha256sum -c "$ARCHIVE.sha256")
fi

tar -xzf "$DOWNLOAD_DIR/$ARCHIVE" -C "$DOWNLOAD_DIR"
RELEASE_ROOT=$(tar -tzf "$DOWNLOAD_DIR/$ARCHIVE" | sed -n '1{s|/.*||;p;}')
if [ -z "$RELEASE_ROOT" ] || [ ! -x "$DOWNLOAD_DIR/$RELEASE_ROOT/install-release.sh" ]; then
  echo "El archivo no contiene un release válido de HA Server." >&2
  exit 1
fi
RELEASE_VERSION=$(cat "$DOWNLOAD_DIR/$RELEASE_ROOT/VERSION")
"$DOWNLOAD_DIR/$RELEASE_ROOT/install-release.sh"
set_server_env() {
  KEY=$1
  VALUE=$2
  if grep -q "^${KEY}=" /etc/ha/server.env; then
    sed -i "s|^${KEY}=.*|${KEY}=${VALUE}|" /etc/ha/server.env
  else
    printf '%s=%s\n' "$KEY" "$VALUE" >>/etc/ha/server.env
  fi
}
if [ "$INSTALL_OLLAMA" = true ]; then
  set_server_env OLLAMA_LOCAL_ENABLED true
  mkdir -p /etc/systemd/system/ha-server.service.d
  printf '%s\n' \
    '[Unit]' \
    'Wants=ollama.service' \
    'After=ollama.service' \
    'PropagatesStopTo=ollama.service' \
    >/etc/systemd/system/ha-server.service.d/ollama.conf
  systemctl disable ollama.service 2>/dev/null || true
else
  set_server_env OLLAMA_LOCAL_ENABLED false
  rm -f /etc/systemd/system/ha-server.service.d/ollama.conf
fi
if [ "$INSTALL_HOME_ASSISTANT" = true ]; then
  set_server_env COMPOSE_PROFILES home-assistant
else
  set_server_env COMPOSE_PROFILES ''
fi
set_server_env WHISPER_MODEL "$WHISPER_MODEL"
set_server_env WHISPER_MODEL_DIR "$WHISPER_MODEL_DIR"
set_server_env WHISPER_MODEL_PATH "$WHISPER_CONFIGURED_MODEL_PATH"
set_server_env WHISPER_MODEL_URL "$WHISPER_CONFIGURED_MODEL_URL"
set_server_env WHISPER_NO_GPU false
set_server_env WHISPER_THREADS 8
set_server_env WHISPER_BEST_OF 1

SERVER_CONFIG_PATH=/etc/ha/server/server.json
node - "$SERVER_CONFIG_PATH" "$INSTALL_HOME_ASSISTANT" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const enabled = process.argv[3] === "true";
const defaults = {
  locale: "es-CL",
  timeZone: "America/Santiago",
  location: {
    city: "Valparaíso", region: "Valparaíso", country: "Chile", countryCode: "CL",
    latitude: -33.0472, longitude: -71.6127, timeZone: "America/Santiago", source: "manual"
  },
  conversationMemory: { enabled: true, maxTurns: 10, maxCharacters: 12000, idleTimeoutMinutes: 15 },
  webSearch: { enabled: true, searxngUrl: "http://127.0.0.1:8888", maxResultsToTry: 3, maxContentCharacters: 6000 },
  llm: {
    provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:9b",
    temperature: 0.1, contextLength: 8192, timeoutMs: 120000, think: false, keepAlive: "30m"
  },
  homeAutomation: { homeAssistant: { enabled: false, baseUrl: "http://127.0.0.1:8123", timeoutMs: 10000 } }
};
let previous = {};
try { previous = JSON.parse(fs.readFileSync(path, "utf8")); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const config = {
  locale: previous.locale ?? defaults.locale,
  timeZone: previous.timeZone ?? defaults.timeZone,
  location: { ...defaults.location, ...(previous.location || {}) },
  conversationMemory: { ...defaults.conversationMemory, ...(previous.conversationMemory || {}) },
  webSearch: { ...defaults.webSearch, ...(previous.webSearch || {}) },
  llm: { ...defaults.llm, ...(previous.llm || {}) },
  homeAutomation: {
    homeAssistant: {
      ...defaults.homeAutomation.homeAssistant,
      ...(previous.homeAutomation?.homeAssistant || {}),
      enabled
    }
  }
};
fs.mkdirSync(require("node:path").dirname(path), { recursive: true });
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640 });
NODE
chown root:ha "$SERVER_CONFIG_PATH"
chmod 0640 "$SERVER_CONFIG_PATH"
systemctl daemon-reload
systemctl restart ha-server

echo
echo "Instalación de HA Server $RELEASE_VERSION completada."
echo "Music Assistant: http://$(hostname -I | awk '{print $1}'):8095"
echo "Crea allí el administrador y autentícalo después desde el display."
if [ "$INSTALL_OLLAMA" = false ]; then
  echo "Pendiente: configura y prueba el proveedor LLM externo desde el display."
fi
if [ "$INSTALL_HOME_ASSISTANT" = true ]; then
  echo "Home Assistant: http://$(hostname -I | awk '{print $1}'):8123"
fi
echo "Diagnóstico: /opt/ha/current/health-check.sh"
