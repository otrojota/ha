# Release del servidor

Esta carpeta contiene la receta de distribución del servidor. Los artefactos generados se escriben en `releases/dist/` y no deben versionarse.

## Bootstrap Fedora y Raspberry Pi OS Lite

`install.sh` soporta Fedora estándar en `x86_64` y `aarch64`, incluida Fedora Asahi Remix, y Raspberry Pi OS Lite de 64 bits en `aarch64`. La detección de Asahi es informativa: se usan paquetes Fedora y binarios ARM64 nativos, sin emulación x86. Raspberry Pi OS de 32 bits se rechaza porque no existe un artefacto `armv7`.

Cuando exista la GitHub Release `v0.1.16`:

```bash
curl -fsSL https://raw.githubusercontent.com/otrojota/ha/main/releases/server/install.sh | sudo sh
```

Para probar un artefacto construido localmente antes de publicarlo:

```bash
sudo HA_RELEASE_ARCHIVE="$PWD/releases/dist/ha-server-0.1.16-linux-arm64.tar.gz" \
  ./releases/server/install.sh
```

El bootstrap pregunta por separado si debe instalar Ollama local y Home Assistant. Si Ollama se rechaza, no lo instala, inicia ni modifica y deja pendiente seleccionar el proveedor LLM externo desde el display. Si Home Assistant se acepta, activa el perfil Docker `home-assistant` en `COMPOSE_PROFILES` y habilita la integración en `server.json`; si se rechaza, ambos quedan desactivados.

Para ejecución no interactiva define las dos decisiones:

```bash
sudo HA_INSTALL_OLLAMA=yes HA_INSTALL_HOME_ASSISTANT=yes ./releases/server/install.sh
```

El bootstrap instala las demás dependencias ausentes. Si encuentra Node, Docker, Ollama local o whisper.cpp por debajo del mínimo probado, se detiene con una advertencia y no modifica esa instalación.

## Construir

Desde la raíz del repositorio:

```bash
./releases/server/package.sh
```

Para indicar otra versión:

```bash
./releases/server/package.sh 0.1.16
```

El resultado contiene el backend, Music Gateway, dependencias de workspace y los archivos de despliegue. No contiene configuración local, credenciales, datos persistentes ni modelos.

## Instalar el artefacto

El instalador de la release supone que Node, npm, Docker Compose y `whisper-cli` ya están instalados. Ollama sólo es necesario cuando se elige como proveedor local. Esa preparación corresponderá al bootstrap público.

```bash
tar -xzf ha-server-0.1.16-linux-x64.tar.gz
sudo ./ha-server-0.1.16/install-release.sh
```

La instalación crea una release inmutable en `/opt/ha/releases/<version>`, conserva `/etc/ha/server.env` si ya existe y usa `/var/lib/ha` para datos y modelos.

Después de copiar el modelo Whisper a `/var/lib/ha/models/whisper/ggml-small.bin`:

```bash
sudo systemctl start ha-containers ha-music-gateway ha-server
/opt/ha/current/health-check.sh
```

Music Assistant requiere crear su administrador en `http://IP_DEL_SERVIDOR:8095`. La autenticación de Music Gateway se completa posteriormente desde el display.
