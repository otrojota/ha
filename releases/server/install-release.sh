#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta este instalador como root." >&2
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(cat "$SOURCE_DIR/VERSION")
RELEASE_DIR="/opt/ha/releases/$VERSION"

for COMMAND in node npm docker curl python3; do
  if ! command -v "$COMMAND" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $COMMAND" >&2
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose no está disponible." >&2
  exit 1
fi

WHISPER_INSTALL_TARGET=/usr/local/bin/whisper-server
WHISPER_CLI_INSTALL_TARGET=/usr/local/bin/whisper-cli
WHISPER_CMAKE_GPU_ARG=
WHISPER_GPU_BACKEND=cpu
WHISPER_VERSION=1.9.2
WHISPER_BUILD_STAMP=/usr/local/share/ha/whisper-build
ASAHI_VULKAN_ICD=/usr/share/vulkan/icd.d/asahi_icd.aarch64.json
if command -v dnf >/dev/null 2>&1; then
  echo "Instalando dependencias de compilación para Whisper…"
  dnf install -y curl ca-certificates tar git cmake gcc gcc-c++ make findutils pkgconf-pkg-config
  if grep -qE '^(ID|ID_LIKE)=.*(fedora-asahi-remix|fedora)' /etc/os-release \
      && { [ -r /proc/device-tree/compatible ] && tr '\000' '\n' </proc/device-tree/compatible | grep -qi apple; }; then
    echo "Instalando Honeykrisp y dependencias Vulkan para Whisper…"
    dnf install -y mesa-vulkan-drivers vulkan-loader vulkan-loader-devel vulkan-headers vulkan-tools glslc spirv-headers-devel
    if [ ! -f "$ASAHI_VULKAN_ICD" ]; then
      echo "No se encontró el ICD Vulkan de Asahi después de instalar Mesa." >&2
      exit 1
    fi
    VK_DRIVER_FILES="$ASAHI_VULKAN_ICD" vulkaninfo --summary >/dev/null 2>&1 \
      || { echo "El driver Vulkan Honeykrisp no está operativo." >&2; exit 1; }
    WHISPER_INSTALL_TARGET=/usr/local/bin/whisper-server-vulkan
    WHISPER_CLI_INSTALL_TARGET=/usr/local/bin/whisper-cli-vulkan
    WHISPER_CMAKE_GPU_ARG=-DGGML_VULKAN=ON
    WHISPER_GPU_BACKEND=vulkan
  fi
fi

WHISPER_BUILD_REQUIRED=false
if [ ! -x "$WHISPER_INSTALL_TARGET" ]; then
  WHISPER_BUILD_REQUIRED=true
elif [ ! -x "$WHISPER_CLI_INSTALL_TARGET" ]; then
  WHISPER_BUILD_REQUIRED=true
elif [ ! -r "$WHISPER_BUILD_STAMP" ] \
    || [ "$(cat "$WHISPER_BUILD_STAMP" 2>/dev/null || true)" != "$WHISPER_VERSION $WHISPER_GPU_BACKEND" ]; then
  WHISPER_BUILD_REQUIRED=true
fi

if [ "$WHISPER_BUILD_REQUIRED" = true ]; then
  for COMMAND in cmake tar install nproc; do
    if ! command -v "$COMMAND" >/dev/null 2>&1; then
      echo "Falta $COMMAND para compilar whisper-server." >&2
      exit 1
    fi
  done
  WHISPER_WORK=$(mktemp -d)
  trap 'rm -rf "$WHISPER_WORK"' EXIT INT TERM
  if [ -n "$WHISPER_CMAKE_GPU_ARG" ]; then
    for COMMAND in glslc pkg-config vulkaninfo; do
      if ! command -v "$COMMAND" >/dev/null 2>&1; then
        echo "Falta $COMMAND para compilar whisper-server con Vulkan." >&2
        exit 1
      fi
    done
    pkg-config --exists vulkan || { echo "No se encontró vulkan.pc." >&2; exit 1; }
    VK_DRIVER_FILES="$ASAHI_VULKAN_ICD" vulkaninfo --summary >/dev/null 2>&1 \
      || { echo "El driver Vulkan Asahi no está operativo." >&2; exit 1; }
  fi
  echo "Compilando whisper-server $WHISPER_VERSION…"
  curl -fsSL "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v$WHISPER_VERSION.tar.gz" -o "$WHISPER_WORK/whisper.tar.gz"
  tar -xzf "$WHISPER_WORK/whisper.tar.gz" -C "$WHISPER_WORK"
  cmake -S "$WHISPER_WORK/whisper.cpp-$WHISPER_VERSION" -B "$WHISPER_WORK/build" \
    -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DBUILD_SHARED_LIBS=OFF $WHISPER_CMAKE_GPU_ARG
  cmake --build "$WHISPER_WORK/build" --config Release --target whisper-cli whisper-server -j "$(nproc)"
  install -m 0755 "$WHISPER_WORK/build/bin/whisper-server" "$WHISPER_INSTALL_TARGET"
  install -m 0755 "$WHISPER_WORK/build/bin/whisper-cli" "$WHISPER_CLI_INSTALL_TARGET"
  mkdir -p "$(dirname -- "$WHISPER_BUILD_STAMP")"
  printf '%s %s\n' "$WHISPER_VERSION" "$WHISPER_GPU_BACKEND" >"$WHISPER_BUILD_STAMP"
  rm -rf "$WHISPER_WORK"
  trap - EXIT INT TERM
fi

if [ "$WHISPER_GPU_BACKEND" = vulkan ]; then
  VK_DRIVER_FILES="$ASAHI_VULKAN_ICD" "$WHISPER_INSTALL_TARGET" --help >/dev/null 2>&1 \
    || { echo "whisper-server Vulkan no puede ejecutarse." >&2; exit 1; }
elif ! "$WHISPER_INSTALL_TARGET" --help >/dev/null 2>&1; then
  echo "whisper-server no puede ejecutarse." >&2
  exit 1
fi

if ! id ha >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/ha --shell /usr/sbin/nologin ha
fi
for GPU_GROUP in render video; do
  if getent group "$GPU_GROUP" >/dev/null 2>&1; then
    usermod -a -G "$GPU_GROUP" ha
  fi
done

echo "Deteniendo los servicios para instalar el release…"
systemctl stop ha-server.service ha-music-gateway.service ha-containers.service 2>/dev/null || true
for SERVICE in ha-server.service ha-music-gateway.service ha-containers.service; do
  if systemctl is-active --quiet "$SERVICE"; then
    echo "No se pudo detener $SERVICE" >&2
    exit 1
  fi
done

mkdir -p /opt/ha/releases /opt/ha/venvs /etc/ha/server /var/lib/ha/models/whisper /var/lib/ha/models/huggingface /var/lib/ha/music-assistant /var/lib/ha/home-assistant /var/lib/ha/caddy/data /var/lib/ha/caddy/config
if [ ! -d "$RELEASE_DIR" ]; then
  cp -R "$SOURCE_DIR" "$RELEASE_DIR"
fi

cd "$RELEASE_DIR"
npm ci --omit=dev

KOKORO_BOOTSTRAP_PYTHON=
for PYTHON_CANDIDATE in python3.12 python3.11 python3.10; do
  if command -v "$PYTHON_CANDIDATE" >/dev/null 2>&1; then
    KOKORO_BOOTSTRAP_PYTHON=$PYTHON_CANDIDATE
    break
  fi
done
if [ -z "$KOKORO_BOOTSTRAP_PYTHON" ] && command -v dnf >/dev/null 2>&1; then
  echo "Instalando Python 3.12 para Kokoro…"
  dnf install -y python3.12
  KOKORO_BOOTSTRAP_PYTHON=python3.12
fi
if [ -z "$KOKORO_BOOTSTRAP_PYTHON" ]; then
  echo "Kokoro requiere Python 3.10, 3.11 o 3.12 y no se encontró una versión compatible." >&2
  exit 1
fi
if [ ! -x /opt/ha/venvs/kokoro/bin/python ] || ! /opt/ha/venvs/kokoro/bin/python -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] < (3, 13) else 1)' >/dev/null 2>&1; then
  "$KOKORO_BOOTSTRAP_PYTHON" -m venv --clear /opt/ha/venvs/kokoro
fi
/opt/ha/venvs/kokoro/bin/python -m pip install --upgrade pip
/opt/ha/venvs/kokoro/bin/pip install 'torch==2.13.0+cpu' --index-url https://download.pytorch.org/whl/cpu
/opt/ha/venvs/kokoro/bin/pip install -r deploy/requirements-kokoro.txt

if [ ! -f /etc/ha/server.env ]; then
  install -m 0640 -o root -g ha deploy/server.env.example /etc/ha/server.env
fi
DEFAULT_TLS_HOST="$(hostname -s | tr '[:upper:]' '[:lower:]').local"
if grep -qx 'SERVER_TLS_HOST=ha-server.local' /etc/ha/server.env; then
  sed -i "s|^SERVER_TLS_HOST=ha-server.local$|SERVER_TLS_HOST=$DEFAULT_TLS_HOST|" /etc/ha/server.env
fi
for TLS_SETTING in \
  "SERVER_TLS_HOST=$DEFAULT_TLS_HOST" \
  'CADDY_IMAGE=caddy:2.11.4-alpine'; do
  TLS_KEY=${TLS_SETTING%%=*}
  grep -q "^${TLS_KEY}=" /etc/ha/server.env || printf '%s\n' "$TLS_SETTING" >>/etc/ha/server.env
done
for TTS_SETTING in \
  'TTS_CONFIG_PATH=/etc/ha/server/tts.json' \
  'KOKORO_PYTHON=/opt/ha/venvs/kokoro/bin/python' \
  'KOKORO_DEVICE=auto' \
  'HF_HOME=/var/lib/ha/models/huggingface'; do
  TTS_KEY=${TTS_SETTING%%=*}
  grep -q "^${TTS_KEY}=" /etc/ha/server.env || printf '%s\n' "$TTS_SETTING" >>/etc/ha/server.env
done
for WHISPER_SETTING in \
  'WHISPER_MODEL=large-v3' \
  'WHISPER_MODEL_DIR=/var/lib/ha/models/whisper' \
  'WHISPER_MODEL_PATH=' \
  'WHISPER_MODEL_URL=' \
  'WHISPER_NO_GPU=false' \
  'WHISPER_THREADS=8' \
  'WHISPER_BEST_OF=1' \
  'WHISPER_SERVER_CLI=whisper-server' \
  'WHISPER_SERVER_HOST=127.0.0.1' \
  'WHISPER_SERVER_PORT=8178' \
  'WHISPER_SERVER_MANAGED=true' \
  'WHISPER_SERVER_STARTUP_TIMEOUT_MS=120000' \
  'WHISPER_SERVER_REQUEST_TIMEOUT_MS=120000' \
  'VOICE_CONTINUOUS_PARTIAL_INTERVAL_MS=700' \
  'VOICE_CONTINUOUS_PARTIAL_MINIMUM_MS=700'; do
  WHISPER_KEY=${WHISPER_SETTING%%=*}
  grep -q "^${WHISPER_KEY}=" /etc/ha/server.env || printf '%s\n' "$WHISPER_SETTING" >>/etc/ha/server.env
done
if [ "$WHISPER_GPU_BACKEND" = vulkan ]; then
  sed -i 's|^WHISPER_SERVER_CLI=.*|WHISPER_SERVER_CLI=/usr/local/bin/whisper-server-vulkan|' /etc/ha/server.env
  if grep -q '^VK_DRIVER_FILES=' /etc/ha/server.env; then
    sed -i "s|^VK_DRIVER_FILES=.*|VK_DRIVER_FILES=$ASAHI_VULKAN_ICD|" /etc/ha/server.env
  else
    printf 'VK_DRIVER_FILES=%s\n' "$ASAHI_VULKAN_ICD" >>/etc/ha/server.env
  fi
fi
if [ ! -f /etc/ha/server/music-assistant.env ]; then
  install -m 0600 -o ha -g ha /dev/null /etc/ha/server/music-assistant.env
fi

chown -R root:root "$RELEASE_DIR"
# El wrapper puede ejecutarse desde una sesión con umask restrictiva. Asegura
# que los servicios sin privilegios puedan recorrer y leer el release.
chmod -R a+rX "$RELEASE_DIR"
chown -R ha:ha /etc/ha/server /var/lib/ha
ln -sfn "$RELEASE_DIR" /opt/ha/current

install -m 0644 deploy/systemd/ha-containers.service /etc/systemd/system/ha-containers.service
install -m 0644 deploy/systemd/ha-music-gateway.service /etc/systemd/system/ha-music-gateway.service
install -m 0644 deploy/systemd/ha-server.service /etc/systemd/system/ha-server.service
systemctl daemon-reload
systemctl disable ha-containers.service ha-music-gateway.service 2>/dev/null || true
systemctl enable ha-server.service
systemctl restart ha-server.service

CADDY_ROOT_SOURCE=/var/lib/ha/caddy/data/caddy/pki/authorities/local/root.crt
CADDY_ROOT_PUBLIC=/var/lib/ha/caddy-root.crt
CADDY_WAIT=0
while [ ! -s "$CADDY_ROOT_SOURCE" ] && [ "$CADDY_WAIT" -lt 60 ]; do
  sleep 1
  CADDY_WAIT=$((CADDY_WAIT + 1))
done
if [ ! -s "$CADDY_ROOT_SOURCE" ]; then
  echo "Caddy no generó su certificado raíz local." >&2
  exit 1
fi
install -m 0644 -o ha -g ha "$CADDY_ROOT_SOURCE" "$CADDY_ROOT_PUBLIC"

echo "Release $VERSION instalada en $RELEASE_DIR"
echo "Configuración: /etc/ha/server.env y /etc/ha/server/"
echo "La release anterior se conserva en /opt/ha/releases para permitir rollback."
echo "Pendiente: verifica Whisper y configura un proveedor LLM local o externo antes de usar el asistente."
