# HA Voice Assistant

Asistente doméstico por voz con backend central, tools y satélites web. El LLM
decide qué hacer; las integraciones ejecutan la acción.

## Arquitectura actual

- `apps/server`: servidor HTTP/WebSocket, sesiones de voz, Whisper, agente y TTS.
- `apps/display`: aplicación HTML/CSS/JavaScript servida por `apps/server`.
- `services/music-gateway`: frontera entre el agente y Music Assistant.
- `packages/contracts`: eventos y framing binario compartidos.
- `packages/shared`: utilidades comunes.

El satélite abre directamente la URL del servidor en Chromium. No ejecuta una
aplicación Node, un servidor HTTP local, FFmpeg ni un motor STT/TTS. La app web:

- captura el micrófono con `getUserMedia`;
- procesa audio en AudioWorklets y un Web Worker;
- transmite PCM mono de 16 kHz en frames `HAI1` de 20 ms;
- reproduce el TTS PCM enviado por el servidor;
- guarda su identidad y preferencias de audio en `localStorage`.

La Raspberry ejecuta además el cliente oficial Sendspin para aparecer como
parlante en Music Assistant. Esa ruta musical es independiente de la salida TTS
elegida en el navegador.

## Desarrollo

Instala dependencias y crea los archivos de entorno:

```bash
npm install
cp dev/server/.env.example dev/server/.env
cp dev/satellite/.env.example dev/satellite/.env
```

Inicia el backend y sus dependencias:

```bash
./dev/server/startServer.sh
```

El display queda en `http://localhost:3000`. Music Gateway usa el puerto `3100`,
Music Assistant `8095` y SearXNG `8888`.

Para registrar el equipo de desarrollo como parlante Music Assistant:

```bash
./dev/satellite/startSatellite.sh
./dev/satellite/stopSatellite.sh
```

Estos dos scripts administran únicamente Sendspin. Para detener el backend:

```bash
./dev/server/stopServer.sh
```

## Voz

Whisper reconoce continuamente la frase de activación y el comando posterior
sobre el mismo audio. El servidor mantiene una sesión aislada por
`satelliteId`, adapta el umbral de voz al piso de ruido y controla el estado
conversacional. Durante la grabación del comando, palabras como “stop”, “alto”
y “detente” son texto normal; sólo interrumpen mientras se reproduce el TTS.

Endpoints de diagnóstico:

```text
GET /voice/input/sessions
GET /voice/states
GET /voice/pipeline
```

Kokoro sintetiza en el servidor y transmite PCM incrementalmente. La voz se
asigna por `satelliteId` y se guarda en `dev/server/config/tts.json`.

## Música

Music Assistant es la fuente única de proveedores, biblioteca, colas y
reproductores. Music Gateway encapsula su API para que las tools no dependan de
ella directamente. La autenticación se completa una vez desde el display; el
gateway persiste un token y no conserva la contraseña.

El destino activo se recuerda por satélite. La primera orden puede indicarlo,
por ejemplo: “toca esta música en el parlante Cocina”.

## Configuración

La configuración del servidor vive en `dev/server/config/` durante desarrollo
y en `/etc/ha/server/` en producción. Las credenciales se guardan separadas de
la configuración no secreta.

La configuración nativa del satélite se limita a Sendspin y a la URL del
servidor:

```text
dev/satellite/.env
/etc/ha/satellite.env
```

Micrófono, canal, salida TTS, nombre del asistente e identidad del navegador se
guardan en el perfil de Chromium.

## Producción

Los paquetes están en `releases/server` y `releases/satellite`. El release del
satélite instala Chromium Kiosk apuntando a `SERVER_URL` y un único servicio
`ha-satellite.service` para Sendspin.

```bash
./releases/server/package.sh
./releases/satellite/package.sh
```

Consulta [INSTALACION.txt](INSTALACION.txt) y
[releases/satellite/README.md](releases/satellite/README.md) para el despliegue.

## Validación

```bash
npm run check
npm test
```
