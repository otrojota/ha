# Release del servidor

Esta carpeta contiene la receta de distribución del servidor. Los artefactos generados se escriben en `releases/dist/` y no deben versionarse.

## Bootstrap Fedora y Raspberry Pi OS Lite

`install.sh` soporta Fedora estándar en `x86_64` y `aarch64`, incluida Fedora Asahi Remix, y Raspberry Pi OS Lite de 64 bits en `aarch64`. En Asahi instala Honeykrisp/Vulkan y compila `whisper.cpp` como binario ARM64 nativo con aceleración de la GPU Apple, sin emulación x86. Raspberry Pi OS de 32 bits se rechaza porque no existe un artefacto `armv7`.

Cuando exista la GitHub Release `vX.Y.Z`:

```bash
curl -fsSL https://raw.githubusercontent.com/otrojota/ha/main/releases/server/install.sh | sudo sh
```

Para probar un artefacto construido localmente antes de publicarlo:

```bash
sudo HA_RELEASE_ARCHIVE="$PWD/releases/dist/ha-server-X.Y.Z-linux-arm64.tar.gz" \
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
./releases/server/package.sh X.Y.Z
```

El resultado contiene el backend, Music Gateway, dependencias de workspace y los archivos de despliegue. No contiene configuración local, credenciales, datos persistentes ni modelos.

## Instalar el artefacto

El instalador de la release supone que Node, npm y Docker Compose ya están
instalados. Si falta `whisper-server`, compila la versión requerida de
whisper.cpp antes de detener los servicios. Ollama sólo es necesario cuando se
elige como proveedor local.

```bash
tar -xzf ha-server-X.Y.Z-linux-ARCH.tar.gz
sudo ./ha-server-X.Y.Z/install-release.sh
```

La instalación crea una release inmutable en `/opt/ha/releases/<version>`, conserva `/etc/ha/server.env` si ya existe y usa `/var/lib/ha` para datos y modelos. Kokoro se instala como único motor de voz central en `/opt/ha/venvs/kokoro`. Los satélites reproducen el PCM TTS y transmiten PCM de micrófono por el WebSocket del protocolo 5; el servidor delimita la frase y ejecuta Whisper.

El display se publica por HTTPS mediante Caddy y una CA local. El hostname se
configura con `SERVER_TLS_HOST` (por defecto, el hostname del servidor con
`.local`). Para que navegadores y teléfonos habiliten micrófono y selección de
salida, instala una vez `/var/lib/ha/caddy-root.crt` como autoridad raíz de
confianza en cada dispositivo cliente y abre `https://SERVER_TLS_HOST`.

`GET /health` informa `activeVoiceInputStreams`. Las métricas acumuladas de
frames, pérdidas y latencia se escriben en el journal con el intervalo
`VOICE_INPUT_METRICS_INTERVAL_MS`. Cada sesión mantiene un ring buffer PCM
acotado por `VOICE_INPUT_RING_BUFFER_MS` y lo reinicia ante discontinuidades
mayores que `VOICE_INPUT_DISCONTINUITY_MS`. `GET /voice/input/sessions` permite
revisar ocupación, continuidad y estado sin exponer el audio.

Whisper reconoce continuamente la frase configurada para cada satélite y el
comando posterior, sin un modelo adicional de wake word. Las transcripciones
parciales llegan al display y una pausa cierra y aplica el comando.

El servidor es además la autoridad del estado conversacional. Publica
`voice.state.changed`, asigna `activationId` y controla timeouts configurables
con `VOICE_STATE_LISTENING_TIMEOUT_MS`. `GET /voice/states` muestra el estado de
cada satélite. La reproducción TTS se cierra sólo al recibir la confirmación
real del satélite.

El VAD y STT se configuran con `VOICE_*`. El diagnóstico
`GET /voice/pipeline` muestra piso de ruido, estado, ventanas y fallos por
satélite. No existe STT local de respaldo.

`WHISPER_MODEL` selecciona el modelo y parte en `large-v3`;
`WHISPER_MODEL_DIR` define dónde se guarda. El servicio descarga el archivo
automáticamente si falta. `WHISPER_MODEL_PATH` o `WHISPER_MODEL_URL` sólo son
necesarios para usar una ruta o fuente personalizada. El instalador activa el
backend Vulkan en un binario separado cuando Fedora Asahi expone la GPU Apple;
`WHISPER_NO_GPU=true` fuerza CPU.

Después de instalar, `ha-server` es la unidad principal y controla también
los contenedores, Music Gateway y, cuando fue instalado localmente, Ollama:

```bash
sudo systemctl start ha-server
/opt/ha/current/health-check.sh
```

`ha-server` queda habilitado para iniciar con Fedora. Puede bajarse y subirse
bajo demanda con `sudo systemctl stop ha-server` y
`sudo systemctl start ha-server`. Docker no se detiene porque puede alojar otros
proyectos, pero todos los contenedores de este asistente sí bajan.

Music Assistant requiere crear su administrador en `http://IP_DEL_SERVIDOR:8095`. La autenticación de Music Gateway se completa posteriormente desde el display.

Para las actualizaciones habituales de `ha-server`, seguir el runbook de
`INSTALACION.txt`.
