#!/bin/sh
set -eu

REPOSITORY=${HA_GITHUB_REPOSITORY:-otrojota/ha}
RELEASE_VERSION=${HA_VERSION:-0.1.59}

[ "$(id -u)" -eq 0 ] || { echo "Ejecuta el instalador como root: curl ... | sudo sh" >&2; exit 1; }
[ -r /etc/os-release ] || { echo "No se pudo identificar el sistema operativo." >&2; exit 1; }
. /etc/os-release
if [ "${ID:-}" != raspbian ] && ! { [ "${ID:-}" = debian ] && [ -r /proc/device-tree/model ] && grep -qi 'Raspberry Pi' /proc/device-tree/model; }; then
  echo "Este instalador sólo soporta Raspberry Pi OS." >&2
  exit 1
fi
case "$(uname -m)" in
  aarch64|arm64) RELEASE_ARCH=arm64 ;;
  *) echo "Se requiere Raspberry Pi OS Lite de 64 bits." >&2; exit 1 ;;
esac

SATELLITE_USER=${HA_SATELLITE_USER:-${SUDO_USER:-}}
if [ -z "$SATELLITE_USER" ] || [ "$SATELLITE_USER" = root ]; then
  if [ -r /dev/tty ]; then
    printf 'Usuario normal que ejecutará Sendspin y Chromium: ' >/dev/tty
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

echo "Instalando dependencias del satélite web…"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  build-essential ca-certificates chromium curl libasound2-dev libffi-dev \
  libnss3-tools openssl pipewire pipewire-pulse portaudio19-dev procps rpd-wayland-core

if [ -n "${HA_SERVER_CA_FILE:-}" ]; then
  [ -r "$HA_SERVER_CA_FILE" ] || { echo "No se puede leer la CA: $HA_SERVER_CA_FILE" >&2; exit 1; }
  openssl x509 -in "$HA_SERVER_CA_FILE" -noout >/dev/null
  install -m 0644 "$HA_SERVER_CA_FILE" /usr/local/share/ca-certificates/ha-server-local-ca.crt
  update-ca-certificates

  SATELLITE_HOME=$(getent passwd "$SATELLITE_USER" | cut -d: -f6)
  SATELLITE_GROUP=$(id -gn "$SATELLITE_USER")
  install -d -m 0700 -o "$SATELLITE_USER" -g "$SATELLITE_GROUP" "$SATELLITE_HOME/.pki" "$SATELLITE_HOME/.pki/nssdb"
  if [ ! -f "$SATELLITE_HOME/.pki/nssdb/cert9.db" ]; then
    runuser -u "$SATELLITE_USER" -- env HOME="$SATELLITE_HOME" certutil -d "sql:$SATELLITE_HOME/.pki/nssdb" -N --empty-password
  fi
  runuser -u "$SATELLITE_USER" -- env HOME="$SATELLITE_HOME" certutil -d "sql:$SATELLITE_HOME/.pki/nssdb" -D -n "HA Server Local CA" >/dev/null 2>&1 || true
  runuser -u "$SATELLITE_USER" -- env HOME="$SATELLITE_HOME" certutil -d "sql:$SATELLITE_HOME/.pki/nssdb" -A -n "HA Server Local CA" -t "C,," -i "$HA_SERVER_CA_FILE"
fi

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
  curl -fL "$DOWNLOAD_BASE/$ARCHIVE" -o "$DOWNLOAD_DIR/$ARCHIVE"
  curl -fL "$DOWNLOAD_BASE/$ARCHIVE.sha256" -o "$DOWNLOAD_DIR/$ARCHIVE.sha256"
  (cd "$DOWNLOAD_DIR" && sha256sum -c "$ARCHIVE.sha256")
fi

tar -xzf "$DOWNLOAD_DIR/$ARCHIVE" -C "$DOWNLOAD_DIR"
HA_SATELLITE_USER="$SATELLITE_USER" "$DOWNLOAD_DIR/ha-satellite-$RELEASE_VERSION/install-release.sh"

echo "Instalación completada. Configura SERVER_URL en /etc/ha/satellite.env."
echo "Verifica en raspi-config que Labwc y Desktop Autologin estén seleccionados."
echo "Diagnóstico: /opt/ha/current/health-check.sh"
