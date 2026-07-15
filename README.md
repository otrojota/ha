# HA Voice Assistant

Base de un asistente de voz distribuido: el backend concentra sesiones, decisiones y herramientas; las Raspberry funcionan como satélites de entrada/salida.

## Estructura

- `apps/server`: backend HTTP/WebSocket y orquestación de eventos.
- `apps/satellite`: cliente del satélite; incluye simulador sin hardware.
- `apps/display`: interfaz HTML/CSS/JavaScript para Chromium Kiosk.
- `services/music-gateway`: frontera desacoplada que usa Music Assistant como fuente única de biblioteca, colas y reproductores.

## Music Assistant

Music Assistant es la única fuente de orígenes musicales, biblioteca, colas y destinos. `MusicGateway` conserva una frontera propia para no acoplar las tools al protocolo de MA, pero no mantiene catálogos ni descubre reproductores por su cuenta. Configura en MA los proveedores deseados (radio, biblioteca local, servicios de streaming, etc.) y el asistente los consultará de forma unificada.

En `dev/server/.env` configura:

```bash
MUSIC_ASSISTANT_URL=http://127.0.0.1:8095
MUSIC_ASSISTANT_TOKEN=
```

`startServer.sh` inicia automáticamente el contenedor oficial de Music Assistant con red host y espera a que su interfaz responda antes de levantar Music Gateway. Sus datos persisten en `dev/server/music-assistant/data`. `stopServer.sh` detiene también el contenedor de MA.

En el primer inicio abre `http://IP_DEL_SERVIDOR:8095` y completa la creación del administrador. Después, desde el display del satélite, abre **Configuración → Music Assistant** e inicia sesión una sola vez. Music Gateway crea automáticamente un token exclusivo, lo guarda con permisos `600` y descarta la contraseña. El backend se inicia aunque esa autorización aún esté pendiente, precisamente para permitir completar este flujo desde el display.

Si el token vence o es revocado, cualquier respuesta `401` de MA lo invalida inmediatamente en memoria. El display consulta el estado cada 30 segundos, vuelve a indicar **Requiere autenticación** y habilita el mismo formulario para renovar la autorización.

El token queda en el archivo ignorado por Git `dev/server/.music-assistant.env`:

```bash
MUSIC_ASSISTANT_TOKEN=token_generado_en_ma
```

El display muestra los orígenes y reproductores informados por MA, permite asignar alias/habitación al reconocimiento por voz y conserva únicamente esas preferencias junto al destino activo en `dev/server/config/music.json`.

### Satélite como parlante de MA

El satélite ejecuta el cliente oficial Sendspin en modo daemon. Sendspin se anuncia por mDNS y Music Assistant lo incorpora como reproductor sin Spotify Connect, librespot ni transmisión directa desde el backend.

`startSatellite.sh` instala automáticamente una copia local de Sendspin y Python 3.12 mediante `uv` si `SENDSPIN_EXECUTABLE=sendspin` y el comando no está disponible. La instalación queda en `dev/satellite/.tools` y sólo se realiza una vez. También puede instalarse manualmente:

```bash
uv tool install sendspin
sendspin audio-devices list
```

Desde **Configuración → Parlante Music Assistant** se define el nombre visible, se habilita el reproductor y opcionalmente se indica el índice, prefijo o dispositivo ALSA de salida. La salida musical es independiente de `outputDeviceId`, que sigue reservada para TTS. En una red local normal, `MUSIC_ASSISTANT_SENDSPIN_URL` queda vacío para usar mDNS; puede fijarse como `ws://IP_MA:8927/sendspin` si el descubrimiento no funciona.
- `packages/contracts`: contratos y tipos de eventos compartidos.
- `packages/shared`: utilidades comunes sin lógica de negocio.

## Inicio rápido

```bash
cp .env.example .env
npm install
npm run dev
```

Abre `http://localhost:8080`. El servidor queda en `http://localhost:3000` y Music Gateway en `http://localhost:3100`.

El satélite emite eventos de presencia periódicos y captura frases desde el micrófono configurado. El backend usa Whisper para reconocerlas y sólo publica en el display las solicitudes iniciadas por la palabra de activación configurada.

## Descubrimiento del servidor

El backend anuncia automáticamente `_ha-assistant._tcp.local` mediante mDNS/DNS-SD. Cada host conserva una identidad UUID propia en `dev/server/config/identity-<hostname>.json`, por lo que los satélites pueden reconocerlo aunque DHCP cambie su IP y dos servidores ejecuten el mismo repositorio compartido.

El satélite descubre servidores en la red local. Si encuentra uno y no existe una selección previa lo elige automáticamente; si encuentra varios, el display permite elegir uno en **Configuración → Servidor**. La selección se persiste en `dev/satellite/config/server.json`. `SERVER_URL=ws://host:3000/ws` agrega un fallback manual a la lista sin ocultar los servidores mDNS.

Servidor y satélites deben compartir la misma red de capa 2 y permitir mDNS por UDP 5353. En una VM de desarrollo debe usarse red puenteada. El satélite deriva WebSocket y STT del servidor elegido; el display usa además esa dirección para las APIs remotas del backend y Music Gateway.

## Desarrollo separado de servidor y satélite

Los entornos de `dev/server` y `dev/satellite` usan procesos nativos para poder acceder al hardware de audio del equipo. Cada uno carga su propio archivo `.env`:

```bash
./dev/server/startServer.sh
./dev/satellite/startSatellite.sh
```

Para detenerlos:

```bash
./dev/satellite/stopSatellite.sh
./dev/server/stopServer.sh
```

Los scripts guardan PID y logs dentro de su carpeta `dev`, evitan arranques duplicados y pueden ejecutarse desde cualquier directorio. El servidor levanta Music Assistant y SearXNG mediante Docker Compose; el script del satélite levanta el display en `http://localhost:8080`.

## Configuración local de audio

Desde el botón de configuración del display se puede seleccionar el micrófono y la salida usada para las respuestas de voz (TTS). La selección se persiste en `dev/satellite/config/audio.json`; no afecta al dispositivo de reproducción musical.

Cuando el micrófono seleccionado expone más de un canal, el display solicita además el canal físico de entrada. El índice se guarda en `inputChannel` (base cero internamente) y será el canal que la futura captura STT convertirá a mono.

El satélite publica la API local en el puerto `3200`. La capa `AudioDeviceProvider` selecciona automáticamente el adaptador correspondiente:

- macOS: entradas mediante AVFoundation/`ffmpeg` y salidas TTS mediante CoreAudio/`say`.
- Linux y Raspberry Pi: entradas y salidas mediante `pactl`, usando la compatibilidad PulseAudio de PipeWire.
- Otros sistemas o herramientas ausentes: dispositivos simulados como fallback.

En macOS debe estar instalado `ffmpeg` (`brew install ffmpeg`). En Linux deben estar disponibles PipeWire y `pactl` —normalmente el paquete `pulseaudio-utils` o equivalente de la distribución— y el proceso debe ejecutarse dentro de la sesión del usuario que posee el servidor de audio.

## Reconocimiento de voz

El nombre y palabra de activación se persisten en `dev/satellite/config/assistant.json`; su valor inicial es `Asistente`. El display permite cambiarlo y valida contra el vocabulario español antes de guardar.

El servidor ejecuta `whisper-cli`, configurable mediante `WHISPER_CLI`, usando el modelo indicado por `WHISPER_MODEL_PATH`. La configuración inicial espera el modelo multilingüe `small` en `dev/server/models/ggml-small.bin`. En macOS puede instalarse el ejecutable con `brew install whisper-cpp`; en Linux debe compilarse o instalarse `whisper.cpp` para la plataforma del servidor. `WHISPER_NO_GPU=true` fuerza CPU cuando el backend gráfico no está disponible o no es estable; puede cambiarse a `false` en el servidor definitivo.

La captura usa `ffmpeg`, respeta `inputDeviceId` e `inputChannel`, extrae sólo ese canal y genera audio WAV mono PCM de 16 kHz. Una pausa de aproximadamente 800 ms marca el final de la frase. Las frases sin la palabra de activación se descartan y no se muestran ni se envían al LLM.

### Palabra de activación local

El satélite usa Vosk con el modelo español pequeño y una gramática dinámica formada por el nombre configurado y `[unk]`. Cambiar el nombre no requiere entrenar otro modelo. La palabra debe existir en el vocabulario español de Vosk; el detector mediante Whisper queda como fallback si Vosk no puede iniciarse.

Vosk procesa continuamente el PCM de 16 kHz en el satélite. Whisper sólo recibe audio durante los 7 segundos posteriores a la detección. Si se dice “asistente”, se hace una pausa y luego se dice la orden, la ventana permanece abierta y la segunda frase se acepta como comando.

Preparación del entorno local:

```bash
python3.11 -m venv dev/satellite/.venv
dev/satellite/.venv/bin/pip install -r dev/satellite/requirements-vosk.txt
mkdir -p dev/satellite/models
curl -L -o /tmp/vosk-model-small-es-0.42.zip https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip
unzip /tmp/vosk-model-small-es-0.42.zip -d dev/satellite/models
```

Para cambiar el nombre se usa Configuración → Nombre del asistente en el display. El satélite valida la frase con Vosk, la guarda en `dev/satellite/config/assistant.json`, recarga el detector en caliente y comunica el nombre al servidor con cada solicitud. No se reentrena ni se vuelve a descargar el modelo.

## Interpretación y tools

El backend usa Ollama con `qwen3.5:9b` para interpretar el texto reconocido. Las tools son módulos de código con una definición JSON para el LLM y un método `execute` registrado en `ToolRegistry`. La primera implementación incluye `assistant_get_identity`, que retorna el nombre, propósito y capacidades configuradas del asistente.

`startServer.sh` usa la instancia indicada por `OLLAMA_URL`. Si apunta a `localhost` o `127.0.0.1` y la API no está disponible, ejecuta `ollama serve` y guarda su PID; si apunta a otra máquina, nunca intenta iniciar ni detener Ollama localmente. `stopServer.sh` sólo detiene Ollama cuando fue iniciado por el propio entorno. El modelo se mantiene cargado durante 30 minutos y el modo thinking está desactivado para reducir latencia de voz.

## Ejecución como servicio Linux

Los mismos scripts POSIX funcionan manualmente en Linux y pueden envolverse en una unidad `systemd` con `ExecStart` y `ExecStop`. Para una instalación definitiva conviene que `systemd` ejecute Node directamente en primer plano y gestione reinicios, usuario, logs y dependencias; la capa de audio y los archivos `.env` son comunes en ambos casos y no requieren cambios en la aplicación.
