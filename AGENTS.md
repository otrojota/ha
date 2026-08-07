# AGENTS.md

## Proyecto

Asistente de voz basado en LLM, inspirado en Alexa pero diseñado como un agente con herramientas (tool calling).

Objetivo:
- Conversación natural por voz.
- Respuestas TTS.
- Control de música.
- Clima, búsquedas web, calendario y futuras herramientas.
- Arquitectura modular y extensible.

---

# Arquitectura

El LLM es el cerebro.

Los componentes externos son herramientas.

```
Wake Word
    │
STT
    │
LLM
    │
Tool Calling
    │
──────────────────────────────────────
Music
Weather
Search
Calendar
Home Automation
...
──────────────────────────────────────
    │
TTS
```

No implementar lógica de negocio en la Raspberry.

La Raspberry es un satélite de voz.

---

# Hardware Raspberry

Objetivo inicial:

- Raspberry Pi 5 (8 GB)
- Pantalla oficial táctil de 7"
- Speakerphone USB (preferentemente tipo EMEET con matriz de micrófonos, AEC y parlante integrado)
- Posibilidad futura de DAC o Bluetooth como salida.

La Raspberry NO ejecutará modelos LLM grandes.

---

# Distribución de responsabilidades

## Raspberry

- Chromium Kiosk con la aplicación servida por el backend
- Captura, procesamiento y reproducción mediante Web Audio
- Reproductor Music Assistant local mediante Sendspin
- Bluetooth

## Backend

- Node.js
- Gestión de sesiones
- Tool Calling
- Integración con LLM
- Spotify/Music
- Clima
- Búsquedas
- WebSocket
- Estado de dispositivos

---

# Música

No depender directamente de Spotify.

Crear una abstracción:

```
MusicGateway
```

Implementación inicial:

```
MusicGateway
    ↓
Music Assistant
```

Music Assistant será responsable de integrar:

- Spotify
- Tidal
- Radio
- Biblioteca local
- Otros proveedores futuros

No acoplar las tools ni el agente directamente a Music Assistant; el acoplamiento queda encapsulado en MusicGateway.

---

# Destinos Music Assistant

La Raspberry aparece como reproductor de Music Assistant mediante el cliente oficial Sendspin en modo daemon. Music Assistant es la fuente única de orígenes, biblioteca, colas y destinos. No usar Spotify Connect ni librespot en el satélite.

Sendspin se configura mediante el entorno del satélite, no desde la aplicación
web. Music Gateway no asigna un destino predeterminado en la primera ejecución;
un destino mencionado por voz queda persistido por `satelliteId` y se reutiliza
en las órdenes posteriores.

---

# UI

Tecnologías:

- HTML
- CSS
- JavaScript
- Bootstrap

Ejecutar en Chromium Kiosk sobre Raspberry Pi OS Lite.

No usar escritorio completo.

La UI mostrará:

- reloj
- clima
- reproducción actual
- dispositivo de reproducción
- texto reconocido
- respuesta del asistente

Comunicación mediante WebSocket.

---

# Repositorio

Utilizar un MONOREPO.

Estructura inicial sugerida:

```
apps/
    server/
    satellite/
    display/

services/
    music-gateway/

packages/
    contracts/
    shared/
```

Usar npm/pnpm workspaces.

No dividir en múltiples repositorios todavía.

---

# Docker

Cada aplicación tendrá su propio Dockerfile.

Docker puede utilizarse para componentes sin acceso directo al hardware. Para las pruebas y la ejecución del satélite con audio real, ejecutar los procesos nativamente: Docker Desktop en macOS no expone CoreAudio y el acceso desde contenedores a PipeWire en Linux requiere sockets y permisos específicos.

Debe existir un modo simulador que permita desarrollar sin hardware físico.

---

# Principios

- Backend desacoplado de proveedores externos.
- Interfaces claras entre módulos.
- Todo controlado mediante eventos.
- Comunicación por WebSocket cuando corresponda.
- El LLM decide QUÉ hacer.
- Las herramientas implementan CÓMO hacerlo.

Priorizar simplicidad, modularidad y posibilidad de crecer hacia múltiples Raspberry distribuidas por la casa sin cambiar la arquitectura.

---

# Estado implementado (6 de agosto de 2026)

FenixIA no forma parte de este proyecto. El foco actual es voz, música y radio mediante Music Assistant, noticias/búsqueda web y futura integración con Home Assistant.

## Ejecución de desarrollo

Los `docker-compose.yml` generales de `dev/server` y `dev/satellite` fueron reemplazados por scripts POSIX que cargan el `.env` de su carpeta, guardan PID y escriben logs locales:

```bash
./dev/server/startServer.sh
./dev/server/stopServer.sh
./dev/satellite/startSatellite.sh
./dev/satellite/stopSatellite.sh
```

- `startServer.sh` valida Whisper/Ollama, reutiliza o inicia `ollama serve`, inicia SearXNG mediante Docker Compose y luego `apps/server`.
- `startServer.sh` inicia también Music Assistant mediante Docker Compose con red host y espera su disponibilidad antes de Music Gateway.
- Si Music Assistant requiere autenticación, el servidor continúa iniciándose. El display permite iniciar sesión una vez; Music Gateway crea y persiste un token de larga duración sin guardar la contraseña.
- `stopServer.sh` detiene servidor, SearXNG y sólo la instancia de Ollama que haya iniciado el propio entorno.
- `stopServer.sh` detiene también el contenedor de Music Assistant administrado por este entorno.
- `apps/server` sirve también la aplicación web del satélite desde su URL raíz.
- `startSatellite.sh` y `stopSatellite.sh` administran únicamente el daemon oficial Sendspin de Music Assistant. Chromium Kiosk se administra por separado.
- Puertos predeterminados: servidor y display `3000`, SearXNG local `8888`.
- Logs principales: `dev/server/server.log`, `dev/server/ollama.log` y `dev/satellite/sendspin.log`.

En producción la Raspberry inicia Chromium Kiosk contra la URL HTTPS del
servidor y el daemon oficial Sendspin para Music Assistant. No ejecuta Node ni
contenedores para la aplicación de voz.

En Fedora, `ha-server.service` es la unidad principal del stack. Al iniciarla
levanta los contenedores Caddy, SearXNG, Music Assistant y, si está habilitado,
Home Assistant, además de Music Gateway y Ollama local. Al detenerla propaga la
detención a esos componentes; Docker permanece activo porque puede alojar
otros proyectos.

## Captura de voz, wake word y STT

`BrowserAudioController`, en `apps/display/public/audio`, abre el micrófono con
`getUserMedia`. Un AudioWorklet extrae el canal elegido y un Web Worker
remuestrea a PCM mono de 16 kHz, construye frames de 20 ms y mantiene el
WebSocket sin bloquear la hebra de la GUI.

El mismo PCM se transmite al servidor por WebSocket mediante frames `HAI1` de
20 ms. El servidor mantiene métricas y una sesión aislada por `satelliteId`.
Cada sesión conserva un ring buffer PCM de 3 segundos, lo reinicia ante pérdidas
o saltos temporales y mantiene el estado conversacional autoritativo. El
diagnóstico está en `GET /voice/input/sessions`; no expone audio.

El mismo Whisper STT reconoce continuamente la frase de activación española y
el comando posterior; no existe un modelo de wake word adicional.
`voice.wake-word.configured` anuncia la frase asignada al satélite.

`VoiceStateCoordinator` en el servidor es la autoridad del
estado conversacional. Publica `voice.state.changed`, asigna un `activationId`,
controla timeouts. El display sólo representa ese evento. El botón manual envía
`voice.listen.requested`; no inicia una captura distinta porque el PCM ya fluye.
`GET /voice/states` expone el diagnóstico actual.

`ContinuousVoiceRecognitionService` delimita voz sobre el PCM continuo,
construye ventanas WAV en memoria y las envía al proceso persistente de Whisper.
Publica transcripciones parciales, detecta la frase en cualquier posición y
aplica como comando lo posterior al cerrar por silencio. Durante la captura del
comando, `stop`, `detente` y `alto` se conservan como palabras normales. Sólo
interrumpen cuando el estado es `speaking`, mientras se reproduce el TTS.
`GET /voice/pipeline` expone sus métricas. No existe STT local de respaldo.

La wake word y la identidad del satélite se guardan en `localStorage` del perfil
Chromium y se anuncian al servidor al registrar el stream.

El backend usa `whisper.cpp` (`whisper-server`) con el modelo configurado en
`dev/server/.env`. En QA usa `small` para que el STT continuo responda en tiempo
real sobre CPU; `large-v3` permanece descargado para uso futuro.
En Fedora Asahi, la instalación usa un binario separado con el backend Vulkan
sobre la GPU Apple y conserva el binario CPU como respaldo.

## Configuración y abstracción de audio

Desde el display se configuran entrada, canal físico y salida exclusiva de TTS.
Los identificadores se guardan en `localStorage` y se aplican con
`getUserMedia` y `AudioContext.setSinkId` cuando está disponible.

La voz se elige también desde el display, pero se persiste centralmente en `dev/server/config/tts.json`, asociada al `satelliteId`.

`inputChannel` es base cero internamente y base uno en la GUI. La selección de
salida TTS no modifica la ruta de música. No existe API de audio local.

## TTS

La síntesis está centralizada en el servidor y se asigna por `satelliteId`. `TtsStreamService` transmite PCM mono de 16 bits por el WebSocket registrado del satélite mediante eventos de inicio/fin y frames binarios secuenciados. Las asignaciones se guardan en `dev/server/config/tts.json`.

Kokoro es el único motor TTS. Genera audio incrementalmente en el servidor; el
satélite no instala voces ni sintetiza y reproduce el stream mediante un
AudioWorklet.

Durante TTS la captura continúa para reconocer una interrupción hablada; el AEC
del speakerphone evita la realimentación. Si no hay salida configurada, la
respuesta sólo se muestra.

## LLM, agente y tools

El backend utiliza Ollama con `qwen3.5:9b` y tool calling. Configuración del modelo en `dev/server/.env`; implementación en `apps/server/src/agent`.

Tools actuales:

- `assistant_get_identity`: nombre, propósito y capacidades.
- `datetime_get_current`: fecha, hora, weekday, locale, zona y offset.
- `datetime_get_date_info`: información de fecha absoluta o relativa.
- `datetime_get_date_difference`: diferencia de días entre fechas.
- `location_get_configured`: ubicación geográfica configurada.
- `web_search_and_read`: búsqueda web y lectura del primer resultado accesible.

El prompt obliga a usar tools para identidad, tiempo, ubicación y datos actuales. El contenido web se considera no confiable y no puede dar instrucciones al agente.

## Memoria de conversación

`ConversationMemory`, en `apps/server/src/agent/conversation-memory.js`, mantiene contexto temporal por `satelliteId`:

- 10 turnos como máximo.
- 12.000 caracteres como máximo.
- Expiración deslizante tras 15 minutos de inactividad.
- Sólo guarda mensajes de usuario y respuestas finales; no persiste resultados completos de tools.
- Es memoria RAM y se pierde al reiniciar el servidor.

Frases como “olvida nuestra conversación”, “borra el contexto”, “empecemos de nuevo” o “nueva conversación” limpian la sesión.

## Búsqueda web

SearXNG se ejecuta localmente mediante `dev/server/searxng/compose.yml`; la configuración habilita su API JSON. `web_search_and_read` usa:

- `SearxngWebSearchProvider` para resultados.
- Mozilla Readability + LinkeDOM para extraer texto principal.
- Hasta tres resultados si el primero no puede leerse.
- Recorte configurable, actualmente 6.000 caracteres.
- Máximo de 1,5 MB, timeout y hasta tres redirecciones.
- Bloqueo de localhost, redes privadas, credenciales en URL y contenido no textual para mitigar SSRF.

Una búsqueda simple debe realizar una sola llamada y resumirse en dos o tres frases adecuadas para TTS, mencionando la fuente.

## Ubicación geográfica

La ubicación manual es la fuente de verdad y está en `dev/server/config/server.json`. Actualmente está configurada en Valparaíso, Chile. Incluye ciudad, región, país, coordenadas y zona horaria.

El display permite editarla o solicitar una sugerencia aproximada por IP pública. La detección usa `https://ipwho.is/`, no guarda automáticamente y requiere confirmar con “Guardar ubicación”. La configuración se actualiza en caliente.

API del servidor:

```text
GET  /config/location
PUT  /config/location
POST /config/location/detect
```

La futura tool de clima debe usar las coordenadas de esta configuración, no inferir la ciudad desde la zona horaria ni desde la IP en cada consulta.

## Display

El display recibe eventos WebSocket y muestra reloj, clima futuro, reproducción, dispositivo, texto reconocido, estado “Escuchando…”, estado “Procesando tu solicitud…”, respuesta final y medidor de micrófono en tiempo real.

Configuraciones táctiles actuales:

- Nombre/wake word.
- Entrada, canal y salida de audio.
- Voz TTS central asignada a este satélite.
- Ubicación manual y sugerencia por IP.

Existe un teclado virtual local reutilizable en `apps/display/public/virtual-keyboard.js` y `.css`. Se abre al enfocar cualquier input, incluye distribución española, acentos, mayúsculas, borrado, cursores y teclado numérico para coordenadas. No depende de un escritorio ni de conexión a Internet.

## Eventos principales

Definidos en `packages/contracts/src/index.js`:

Todos los eventos incluyen `protocolVersion: "5"`; servidor y aplicación web
validan que el protocolo coincida.

```text
satellite.connected
satellite.heartbeat
voice.state.changed
voice.listen.requested
voice.wake-word.configured
voice.transcript.received
assistant.processing.started
assistant.response.created
assistant.speech.stream.started
assistant.speech.stream.ended
assistant.speech.stream.failed
assistant.speech.playback.ended
weather.updated
```

## Pendientes recomendados

- Validar Kokoro y sus voces españolas en el servidor Fedora ARM64.
- Validar Chromium Kiosk y los permisos persistentes de micrófono en Raspberry Pi OS Lite.
- Evaluar una alternativa web a Sendspin cuando Music Assistant exponga un SDK de reproductor estable para navegadores.
- Añadir pruebas automatizadas persistentes para tools, memoria, filtros de ruido y componentes del display.
