# Primer release del satélite para Raspberry Pi

Esta receta genera e instala `ha-satellite` 0.1.32 en Raspberry Pi OS Lite de
64 bits. Está dirigida inicialmente a Raspberry Pi 4 con pantalla táctil
oficial, PipeWire y Chromium Kiosk sobre Wayland/Labwc.

## Qué instala el bootstrap

- Node.js 20.
- PipeWire, herramientas PulseAudio y FFmpeg.
- Wayland/Labwc, Chromium y `wlr-randr`, sin el conjunto completo de
  aplicaciones de escritorio. La selección de Labwc y Desktop Autologin se
  realiza manualmente en `raspi-config`, porque sus opciones no son estables
  entre versiones de Raspberry Pi OS.
- Vosk 0.3.45 y el modelo español `vosk-model-small-es-0.42`.
- Piper 1.4.2 y la voz española `es_ES-sharvard-medium`.
- El cliente oficial Sendspin mediante `uv` y Python 3.12.
- Servicios `ha-display.service` y `ha-satellite.service`.
- Inicio automático de Chromium en `http://localhost:8080` cuando no existe ya
  una entrada equivalente en el autostart de Labwc.

El proceso de voz se ejecuta con el usuario normal de Raspberry Pi OS para
tener acceso a su sesión PipeWire. El instalador toma `SUDO_USER` o permite
indicarlo con `HA_SATELLITE_USER`.

## Construir el artefacto

Desde la raíz del monorepo:

```bash
./releases/satellite/package.sh
```

El resultado es:

```text
releases/dist/ha-satellite-0.1.32-linux-arm64.tar.gz
releases/dist/ha-satellite-0.1.32-linux-arm64.tar.gz.sha256
```

## Probar un artefacto local en la Raspberry Pi

Después de copiar el `.tar.gz` a la Raspberry:

```bash
sudo HA_SATELLITE_USER="$USER" \
  HA_RELEASE_ARCHIVE="$PWD/ha-satellite-0.1.32-linux-arm64.tar.gz" \
  ./releases/satellite/install.sh
```

Para una GitHub Release publicada con tag `satellite-v0.1.32`:

```bash
curl -fsSL https://raw.githubusercontent.com/otrojota/ha/main/releases/satellite/install.sh | sudo sh
```

## Configuración y datos persistentes

```text
/etc/ha/satellite.env
/etc/ha/satellite/audio.json
/etc/ha/satellite/assistant.json
/etc/ha/satellite/server.json
/var/lib/ha/models/vosk-model-small-es-0.42
/var/lib/ha/models/piper
```

El backend se descubre exclusivamente mediante mDNS. El satélite conserva el
último endpoint seleccionado para poder reconectarse si arranca antes que el
servidor; no se configura una URL manual.

Después de modificar `/etc/ha/satellite.env`:

```bash
sudo systemctl restart ha-display ha-satellite
```

## Diagnóstico

```bash
/opt/ha/current/health-check.sh
sudo systemctl status ha-display ha-satellite --no-pager
sudo journalctl -u ha-satellite -f
```

La configuración inicial de entrada, canal, salida, voz y servidor se completa
desde el display táctil.

La escucha automática de la palabra de activación está habilitada por defecto
y puede apagarse en la configuración del asistente. Al apagarla se detienen
Vosk y la captura continua; el botón de micrófono de la pantalla permanece
disponible para iniciar una única ventana de escucha manual.

En la primera instalación, `SATELLITE_ID` se deriva del hostname de la
Raspberry para evitar que dos satélites nuevos compartan identidad. Se puede
definir explícitamente con `HA_SATELLITE_ID` durante el bootstrap. Las
actualizaciones conservan el identificador existente.
