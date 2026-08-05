#!/bin/sh
set -eu

REPOSITORY=${HA_GITHUB_REPOSITORY:-otrojota/ha}
RELEASE_VERSION=${HA_VERSION:-0.1.20}
NODE_MIN=20.19.0
VOSK_MODEL=vosk-model-small-es-0.42
VOSK_MODEL_URL=https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip
PIPER_VOICES=${PIPER_VOICES:-}
PIPER_VOICES_CATALOG=https://huggingface.co/rhasspy/piper-voices/raw/main/voices.json

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta el instalador como root: curl ... | sudo sh" >&2
  exit 1
fi
if [ ! -r /etc/os-release ]; then
  echo "No se pudo identificar el sistema operativo." >&2
  exit 1
fi

. /etc/os-release
IS_RASPBERRY_PI_OS=false
if [ "${ID:-}" = raspbian ]; then
  IS_RASPBERRY_PI_OS=true
elif [ "${ID:-}" = debian ] && [ -r /proc/device-tree/model ] && grep -qi 'Raspberry Pi' /proc/device-tree/model; then
  IS_RASPBERRY_PI_OS=true
fi
if [ "$IS_RASPBERRY_PI_OS" != true ]; then
  echo "Este instalador sólo soporta Raspberry Pi OS. Sistema detectado: ${ID:-desconocido}" >&2
  exit 1
fi
case "$(uname -m)" in
  aarch64|arm64) RELEASE_ARCH=arm64 ;;
  armv7l) echo "Se requiere Raspberry Pi OS Lite de 64 bits." >&2; exit 1 ;;
  *) echo "Arquitectura no soportada: $(uname -m)" >&2; exit 1 ;;
esac

SATELLITE_USER=${HA_SATELLITE_USER:-${SUDO_USER:-}}
if [ -z "$SATELLITE_USER" ] || [ "$SATELLITE_USER" = root ]; then
  if [ -r /dev/tty ]; then
    printf 'Usuario normal que ejecutará el satélite y Chromium: ' >/dev/tty
    IFS= read -r SATELLITE_USER </dev/tty
  else
    echo "Define HA_SATELLITE_USER con el usuario normal de Raspberry Pi OS." >&2
    exit 1
  fi
fi
if ! id "$SATELLITE_USER" >/dev/null 2>&1 || [ "$(id -u "$SATELLITE_USER")" -eq 0 ]; then
  echo "Usuario de satélite inválido: $SATELLITE_USER" >&2
  exit 1
fi

version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

echo "Instalando dependencias para Raspberry Pi OS Lite…"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  build-essential ca-certificates curl ffmpeg git libasound2-dev libffi-dev \
  pipewire pipewire-pulse portaudio19-dev pulseaudio-utils python3 python3-pip \
  python3-venv rpd-wayland-core chromium cog unzip wlr-randr

INSTALL_NODE=false
if ! command -v node >/dev/null 2>&1; then
  INSTALL_NODE=true
elif ! version_ge "$(node --version | sed 's/^v//')" "$NODE_MIN"; then
  INSTALL_NODE=true
fi
if [ "$INSTALL_NODE" = true ]; then
  echo "Instalando Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sh
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
NODE_VERSION=$(node --version | sed 's/^v//')
if ! version_ge "$NODE_VERSION" "$NODE_MIN"; then
  echo "Node $NODE_VERSION no cumple el mínimo $NODE_MIN." >&2
  exit 1
fi

echo "Preparando Vosk y Piper…"
python3 -m venv /opt/ha/venvs/satellite
/opt/ha/venvs/satellite/bin/python -m pip install --upgrade pip
/opt/ha/venvs/satellite/bin/pip install 'vosk==0.3.45' 'piper-tts==1.4.2' \
  'numpy>=1.24,<3' 'onnxruntime>=1.17,<2' 'requests>=2,<3' \
  'scikit-learn>=1,<2' 'scipy>=1.3,<2' 'tqdm>=4,<5'
/opt/ha/venvs/satellite/bin/pip install --no-deps 'openwakeword==0.6.0'

mkdir -p /var/lib/ha/models /var/lib/ha/models/piper
if [ ! -d "/var/lib/ha/models/$VOSK_MODEL" ]; then
  TEMP_MODELS=$(mktemp -d)
  echo "Descargando modelo Vosk español…"
  curl -fL "$VOSK_MODEL_URL" -o "$TEMP_MODELS/vosk.zip"
  unzip -q "$TEMP_MODELS/vosk.zip" -d /var/lib/ha/models
  rm -rf "$TEMP_MODELS"
fi
if [ -z "$PIPER_VOICES" ]; then
  PIPER_CATALOG_FILE=$(mktemp)
  echo "Consultando catálogo oficial de voces Piper en español…"
  curl -fL "$PIPER_VOICES_CATALOG" -o "$PIPER_CATALOG_FILE"
  PIPER_VOICES=$(/opt/ha/venvs/satellite/bin/python -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); print(" ".join(sorted(key for key in data if key.startswith("es_"))))' "$PIPER_CATALOG_FILE")
  rm -f "$PIPER_CATALOG_FILE"
fi
if [ -z "$PIPER_VOICES" ]; then
  echo "El catálogo de Piper no contiene voces en español." >&2
  exit 1
fi
for PIPER_VOICE in $PIPER_VOICES; do
  if [ ! -f "/var/lib/ha/models/piper/$PIPER_VOICE.onnx" ] || [ ! -f "/var/lib/ha/models/piper/$PIPER_VOICE.onnx.json" ]; then
    echo "Descargando voz Piper $PIPER_VOICE…"
    /opt/ha/venvs/satellite/bin/python -m piper.download_voices \
      --data-dir /var/lib/ha/models/piper "$PIPER_VOICE"
  fi
done

echo "Instalando cliente Sendspin…"
mkdir -p /opt/ha/tools/bin /opt/ha/tools/uv-tools /opt/ha/tools/uv-python
if [ ! -x /opt/ha/tools/bin/uv ]; then
  UV_INSTALL_DIR=/opt/ha/tools/bin UV_NO_MODIFY_PATH=1 sh -c "$(curl -LsSf https://astral.sh/uv/install.sh)"
fi
if [ ! -x /opt/ha/tools/bin/sendspin ]; then
  UV_TOOL_BIN_DIR=/opt/ha/tools/bin \
  UV_TOOL_DIR=/opt/ha/tools/uv-tools \
  UV_PYTHON_INSTALL_DIR=/opt/ha/tools/uv-python \
    /opt/ha/tools/bin/uv tool install --python 3.12 sendspin
fi

ARCHIVE="ha-satellite-$RELEASE_VERSION-linux-$RELEASE_ARCH.tar.gz"
DOWNLOAD_BASE="https://github.com/$REPOSITORY/releases/download/satellite-v$RELEASE_VERSION"
DOWNLOAD_DIR=$(mktemp -d)
if [ -n "${HA_RELEASE_ARCHIVE:-}" ]; then
  cp "$HA_RELEASE_ARCHIVE" "$DOWNLOAD_DIR/$ARCHIVE"
else
  echo "Descargando release del satélite $RELEASE_VERSION…"
  curl -fL "$DOWNLOAD_BASE/$ARCHIVE" -o "$DOWNLOAD_DIR/$ARCHIVE"
  curl -fL "$DOWNLOAD_BASE/$ARCHIVE.sha256" -o "$DOWNLOAD_DIR/$ARCHIVE.sha256"
  (cd "$DOWNLOAD_DIR" && sha256sum -c "$ARCHIVE.sha256")
fi

tar -xzf "$DOWNLOAD_DIR/$ARCHIVE" -C "$DOWNLOAD_DIR"
HA_SATELLITE_USER="$SATELLITE_USER" "$DOWNLOAD_DIR/ha-satellite-$RELEASE_VERSION/install-release.sh"

echo
echo "Instalación del satélite $RELEASE_VERSION completada."
echo "Verifica en raspi-config que Labwc y Desktop Autologin estén seleccionados."
echo "Luego reinicia para iniciar Chromium Kiosk: sudo reboot"
echo "Diagnóstico: /opt/ha/current/health-check.sh"
