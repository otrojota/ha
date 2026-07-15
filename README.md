# HA Voice Assistant

Base de un asistente de voz distribuido: el backend concentra sesiones, decisiones y herramientas; las Raspberry funcionan como satélites de entrada/salida.

## Estructura

- `apps/server`: backend HTTP/WebSocket y orquestación de eventos.
- `apps/satellite`: cliente del satélite; incluye simulador sin hardware.
- `apps/display`: interfaz HTML/CSS/JavaScript para Chromium Kiosk.
- `services/music-gateway`: abstracción de música con proveedor simulado inicial.

## Spotify Connect

Music Gateway descubre destinos mediante Spotify Web API. En el display, abre **Configuración → Destinos de música → Spotify Connect**, introduce el Client ID de una aplicación creada en Spotify for Developers y registra en esa aplicación la Redirect URI que muestra la pantalla. El flujo OAuth usa PKCE y no requiere Client Secret. Los tokens se guardan únicamente en `dev/server/config/music.json`, fuera de Git.

La cuenta y el propietario de la aplicación deben cumplir los requisitos vigentes de Spotify, incluido Premium para las aplicaciones en Development Mode. Spotify sólo devuelve dispositivos Connect disponibles recientemente para esa cuenta; abre Spotify en el dispositivo si no aparece y repite la búsqueda.
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

Los scripts guardan PID y logs dentro de su carpeta `dev`, evitan arranques duplicados y pueden ejecutarse desde cualquier directorio. El script del satélite también levanta el display en `http://localhost:8080`.

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

`startServer.sh` reutiliza Ollama si la API ya está disponible; en caso contrario ejecuta `ollama serve` y guarda su PID. `stopServer.sh` sólo detiene Ollama cuando fue iniciado por el propio entorno. El modelo se mantiene cargado durante 30 minutos y el modo thinking está desactivado para reducir latencia de voz.

## Ejecución como servicio Linux

Los mismos scripts POSIX funcionan manualmente en Linux y pueden envolverse en una unidad `systemd` con `ExecStart` y `ExecStop`. Para una instalación definitiva conviene que `systemd` ejecute Node directamente en primer plano y gestione reinicios, usuario, logs y dependencias; la capa de audio y los archivos `.env` son comunes en ambos casos y no requieren cambios en la aplicación.
