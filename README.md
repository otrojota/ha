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

El satélite descubre servidores en la red local. Si encuentra uno y no existe una selección previa lo elige automáticamente; si encuentra varios, el display permite elegir uno en **Configuración → Servidor**. La selección y el último endpoint conocido se persisten en `dev/satellite/config/server.json`, de modo que pueda reconectarse durante el arranque aunque mDNS aún no haya anunciado el servidor.

Servidor y satélites deben compartir la misma red de capa 2 y permitir mDNS por UDP 5353. En una VM de desarrollo debe usarse red puenteada. El satélite deriva los endpoints canónicos del servidor elegido; no existe configuración manual ni compatibilidad con anuncios de protocolos anteriores.

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

El nombre y palabra de activación se persisten en `dev/satellite/config/assistant.json`; su valor inicial es `Asistente`. En `Configuración → Asistente → Nombre y activación`, el display permite cambiarlo, valida contra el vocabulario español y permite apagar la detección automática conservando el botón de escucha manual.

El servidor ejecuta `whisper-cli`, configurable mediante `WHISPER_CLI`, usando el modelo indicado por `WHISPER_MODEL_PATH`. La configuración inicial espera el modelo multilingüe `small` en `dev/server/models/ggml-small.bin`. En macOS puede instalarse el ejecutable con `brew install whisper-cpp`; en Linux debe compilarse o instalarse `whisper.cpp` para la plataforma del servidor. `WHISPER_NO_GPU=true` fuerza CPU cuando el backend gráfico no está disponible o no es estable; puede cambiarse a `false` en el servidor definitivo.

## Modelos entrenados de wake word

El servidor expone la administración en `http://localhost:3000/wake-word/`. Cada
modelo tiene un único archivo vigente, sin versiones. Reemplazarlo actualiza de
forma monotónica su `modifiedAt`, el mtime real, SHA-256, `Last-Modified` y
`ETag`; un satélite puede comparar ese timestamp con el archivo descargado y
ofrecer la actualización cuando cambie.

En desarrollo los datos se guardan por defecto en `dev/server/wake-word`; en
producción, en `/var/lib/ha/wake-word`. La web permite crear modelos, cargar o
reemplazar un ONNX y acumular muestras WAV positivas y negativas. Puede cargar
archivos o grabar directamente desde un micrófono seleccionado en el navegador;
cada toma se convierte a WAV PCM y se sube al servidor. El catálogo y las
descargas están bajo `/api/wake-word/models`.

La sección “Probar modelo” graba audio sin incorporarlo inicialmente al
dataset, ejecuta el ONNX con el mismo barrido temporal del satélite y muestra
score, umbral y decisión. Una prueba útil puede agregarse después al
entrenamiento como positiva o negativa desde el mismo resultado.

Los navegadores sólo permiten capturar micrófono en un contexto seguro. En
desarrollo funciona en `http://localhost:3000/wake-word/`. Para administrar el
servidor remoto sin HTTPS se puede abrir un túnel local:

```bash
ssh -L 3000:127.0.0.1:3000 ha-server
```

y entrar a `http://localhost:3000/wake-word/`.

El entrenamiento se ejecuta fuera del proceso HTTP. El repositorio incluye
`apps/server/wake-word-trainer/run.sh`, que se selecciona automáticamente. En
el primer uso instala de forma aislada `uv`, Python 3.11 y sus dependencias, y
descarga a caché las voces españolas de Piper y los extractores ONNX de
openWakeWord. Funciona por CPU tanto en macOS Apple Silicon como en Fedora
ARM64; no modifica el Python del sistema.

El entrenador sintetiza adultos de distintas regiones y géneros, agrega
variaciones de velocidad, ganancia, reverberación y ruido, incorpora las
muestras positivas y negativas cargadas en la web y genera un clasificador
ONNX. Los entrenamientos posteriores reutilizan todo lo descargado. La primera
ejecución requiere Internet y demora más.

Al seleccionar un ONNX, el satélite puede habilitar “Modo entrenamiento”. En
ese modo conserva el audio que produjo cada activación: lo envía como positivo
sólo cuando el agente terminó correctamente el comando, y permite marcar una
activación como “Detección falsa” desde el display para enviarla como negativa.
Fuera de ese modo no se recolecta audio de entrenamiento.

Cada diez minutos el servidor revisa si existen muestras posteriores al ONNX
vigente y, si no hay otro entrenamiento activo, inicia uno automáticamente.
El intervalo se configura con `WAKE_WORD_AUTO_TRAIN_INTERVAL_MS`. El satélite
consulta cada minuto el modelo activo, configurable con
`WAKE_WORD_MODEL_REFRESH_MS`, y descarga y recarga en caliente cualquier cambio
de SHA-256 o `modifiedAt`.

`WAKE_WORD_TRAINER_RUNTIME_PATH` permite cambiar la ubicación del entorno y la
caché. Por defecto usa `dev/server/wake-word-trainer/.runtime` en desarrollo y
`/var/lib/ha/wake-word-trainer` en una instalación del servidor. Para sustituir
el entrenador incluido, `WAKE_WORD_TRAINER_EXECUTABLE` puede apuntar a otro
ejecutable que acepte:

```text
--model-id ID --wake-word FRASE --model-dir DIRECTORIO \
--output ARCHIVO_ONNX --config-json JSON
```

Debe terminar con código cero y escribir el ONNX en `--output`. Sólo entonces
el servidor reemplaza atómicamente el archivo vigente. Si falla, conserva el
modelo anterior.

La captura usa `ffmpeg`, respeta `inputDeviceId` e `inputChannel`, extrae sólo ese canal y genera audio WAV mono PCM de 16 kHz. Una pausa de aproximadamente 800 ms marca el final de la frase. Las frases sin la palabra de activación se descartan y no se muestran ni se envían al LLM.

### Palabra de activación local

El satélite usa Vosk con el modelo español pequeño y una gramática dinámica formada por el nombre configurado y `[unk]`. Cambiar el nombre no requiere entrenar otro modelo. La palabra debe existir en el vocabulario español de Vosk; el detector mediante Whisper queda como fallback si Vosk no puede iniciarse.

Cuando “Activación por nombre” está habilitada, el display permite conservar
Vosk o seleccionar uno de los modelos ONNX publicados por el servidor. El
satélite consulta `/api/wake-word/models`, descarga el modelo con verificación
SHA-256 y conserva su metadata bajo `dev/satellite/models/wake-word` en
desarrollo o `/var/lib/ha/models/wake-word` en Raspberry.

Al arrancar compara `modifiedAt` y SHA-256 del modelo seleccionado con el
catálogo y lo actualiza si cualquiera cambió. Si el servidor está temporalmente inaccesible utiliza la
copia local verificada. Al entrar a la configuración vuelve a consultar el
catálogo y ofrece “Descargar actualización” cuando corresponde. El detector
ONNX usa el mismo proceso Python y los mismos extractores openWakeWord en macOS
Apple Silicon y Raspberry Pi ARM64.

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

El backend permite seleccionar desde el display Ollama, OpenAI API, GitHub Models o cualquier API compatible con OpenAI. La configuración no secreta se guarda en `server.json`; las API keys se almacenan aparte en `secrets.json`, con permisos restringidos, y nunca se devuelven al display. Antes de activar un cambio, el servidor comprueba conexión y tool calling. Las tools son módulos de código con una definición JSON para el LLM y un método `execute` registrado en `ToolRegistry`.

`startServer.sh` sólo verifica o inicia Ollama cuando ése es el proveedor activo. Si la URL configurada apunta a `localhost` o `127.0.0.1` y la API no está disponible, ejecuta `ollama serve` y guarda su PID; con un proveedor externo no inicia Ollama. `stopServer.sh` sólo detiene una instancia iniciada por el propio entorno.

## Ejecución como servicio Linux

Los mismos scripts POSIX funcionan manualmente en Linux y pueden envolverse en una unidad `systemd` con `ExecStart` y `ExecStop`. Para una instalación definitiva conviene que `systemd` ejecute Node directamente en primer plano y gestione reinicios, usuario, logs y dependencias; la capa de audio y los archivos `.env` son comunes en ambos casos y no requieren cambios en la aplicación.

### Rutas de configuración de producción

En Linux, los scripts cargan `/etc/ha/server.env` y `/etc/ha/satellite.env` cuando existen. Si no existen, conservan los archivos de desarrollo `dev/server/.env` y `dev/satellite/.env`. Las variables declaradas en esos archivos siempre tienen prioridad.

Cuando están creados los directorios del componente, las rutas persistentes predeterminadas son:

```text
/etc/ha/server/server.json
/etc/ha/server/secrets.json
/etc/ha/server/identity-<hostname>.json
/etc/ha/server/alarms.json
/etc/ha/server/music.json
/etc/ha/server/music-assistant.env

/etc/ha/satellite/audio.json
/etc/ha/satellite/assistant.json
/etc/ha/satellite/server.json
```

Si `/etc/ha/server` o `/etc/ha/satellite` no existen, cada componente usa automáticamente su ruta equivalente dentro de `dev/`. El instalador debe crear los directorios de producción y asignarlos al usuario que ejecuta cada servicio, porque la aplicación actualiza estos archivos de forma atómica.
