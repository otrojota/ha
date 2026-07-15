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

- Wake Word
- Captura de audio
- PipeWire
- TTS Player
- Reproductor Music Assistant local mediante Sendspin
- UI
- Bluetooth
- Comunicación con backend

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

# Estado implementado (15 de julio de 2026)

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
- `startSatellite.sh` inicia `apps/satellite` y `apps/display` nativamente para conservar acceso a CoreAudio/PipeWire.
- Puertos predeterminados: servidor `3000`, API local del satélite `3200`, display `8080`, SearXNG local `8888`.
- Logs: `dev/server/server.log`, `dev/server/ollama.log`, `dev/satellite/satellite.log` y `dev/satellite/display.log`.

Para producción en Raspberry se recomienda `systemd` ejecutando Node en primer plano y gestionando reinicios. El satélite con audio real no debe ejecutarse dentro de Docker.

## Captura de voz, wake word y STT

`VoiceCapture`, en `apps/satellite/src/voice/voice-capture.js`, captura mediante `ffmpeg`, respeta dispositivo/canal seleccionado, extrae un único canal, remuestrea a PCM mono de 16 kHz, segmenta por silencio y publica el nivel RMS para el display.

La wake word es el nombre configurable del asistente y se persiste en:

```text
dev/satellite/config/assistant.json
```

El valor actual puede cambiarse desde Configuración del display. La API valida formato y que todas las palabras existan en el vocabulario español de Vosk antes de guardar y reinicia el detector en caliente:

```text
GET /assistant
PUT /assistant
```

El detector local usa Vosk (`apps/satellite/src/voice/vosk_detector.py`) con el modelo `vosk-model-small-es-0.42`. No requiere entrenamiento al cambiar el nombre. Para reducir falsos positivos con televisión o música:

- Sólo acepta resultados Vosk finalizados, nunca parciales.
- Exige confianza mínima configurable (`WAKE_WORD_MIN_CONFIDENCE`, actualmente `0.82`).
- Cooldown actual de 5 segundos.
- Ventana de comando actual de 4 segundos.
- Una activación consume una sola frase y no se prolonga con detecciones repetidas.
- Si se pronuncia únicamente la wake word, permite una única frase posterior.
- El servidor descarta transcripciones de ruido como `[Música]`, `[Motor]` y `[SILENCIO]`.

El audio activado se envía a `POST /stt/transcribe`. El backend usa `whisper.cpp` (`whisper-cli`) con el modelo configurado en `dev/server/.env`. Whisper sólo se ejecuta durante una activación válida de Vosk.

## Configuración y abstracción de audio

Desde el display se configuran entrada, canal físico, salida exclusiva de TTS y voz. Se persiste en:

```text
dev/satellite/config/audio.json
```

Formato:

```json
{
  "inputDeviceId": null,
  "inputDeviceIds": [],
  "inputDeviceNames": {},
  "inputChannel": null,
  "inputChannelsByDevice": {},
  "outputDeviceId": null,
  "outputDeviceIds": [],
  "outputDeviceNames": {},
  "ttsVoiceId": null
}
```

`inputChannel` es base cero internamente y base uno en la GUI. La selección de salida TTS no modifica la ruta de música.
Las listas `inputDeviceIds` y `outputDeviceIds` están ordenadas por prioridad. Cada nueva selección pasa al primer lugar y las anteriores quedan como fallback automático. Los nombres permiten reencontrar dispositivos CoreAudio aunque macOS cambie sus índices; el canal de entrada se conserva por dispositivo.

Proveedores bajo `apps/satellite/src/audio`:

- `CoreAudioDeviceProvider`: AVFoundation/`ffmpeg` para entradas y `say -a '?'` para salidas en macOS.
- `PipeWireAudioDeviceProvider`: `pactl` sobre PipeWire para Raspberry/Linux.
- `SimulatedAudioDeviceProvider`: fallback para CI y modo simulador.

API local:

```text
GET /audio
GET /audio/input-channels?deviceId=...
PUT /audio
```

La enumeración multicanal fue probada con una Behringer UMC404HD.

## TTS

La síntesis ocurre en el satélite, no en el servidor. El servidor emite `assistant.speech.requested` dirigido al `satelliteId` que originó la consulta; mensajes de conexión o procesamiento no se leen.

Proveedores bajo `apps/satellite/src/tts`:

- macOS: `say`, usando voz española y el ID CoreAudio configurado.
- Raspberry/Linux: Piper local genera WAV y `pw-play --target` lo reproduce mediante PipeWire.
- Simulado: registra el texto sin reproducir audio.

Durante TTS la captura se pausa para evitar realimentación y se reanuda 200 ms después. Si no hay salida configurada, la respuesta sólo se muestra. En Raspberry todavía hay que instalar Piper y colocar modelos `.onnx` en `dev/satellite/models/piper`; se descubren automáticamente.

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
- Voz TTS instalada en la plataforma.
- Ubicación manual y sugerencia por IP.

Existe un teclado virtual local reutilizable en `apps/display/public/virtual-keyboard.js` y `.css`. Se abre al enfocar cualquier input, incluye distribución española, acentos, mayúsculas, borrado, cursores y teclado numérico para coordenadas. No depende de un escritorio ni de conexión a Internet.

## Eventos principales

Definidos en `packages/contracts/src/index.js`:

```text
satellite.connected
satellite.heartbeat
audio.level.updated
voice.wake-word.detected
voice.transcript.received
assistant.processing.started
assistant.response.created
assistant.speech.requested
music.playback.changed
weather.updated
```

## Pendientes recomendados

- Implementar una tool meteorológica usando la ubicación configurada y publicar `weather.updated`.
- Implementar comandos de música/radio a través de `MusicGateway`, sin acoplar el agente a Music Assistant o Spotify.
- Instalar y validar Piper/voz española en Raspberry Pi.
- Añadir AEC/barge-in real; por ahora la captura simplemente se pausa durante TTS.
- Convertir los scripts de producción en unidades `systemd` y validar Chromium Kiosk sobre Raspberry Pi OS Lite.
- Añadir pruebas automatizadas persistentes para tools, memoria, filtros de ruido y componentes del display.
