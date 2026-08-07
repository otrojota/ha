# Audio web del satélite

La ruta de voz se ejecuta completamente dentro de Chromium. No requiere un
servicio Node ni FFmpeg en la Raspberry.

## Flujo de entrada

1. `getUserMedia` abre el micrófono con cancelación de eco y supresión de ruido.
2. `capture-worklet.js` recibe el audio fuera de la hebra del DOM, lo convierte
   a PCM mono de 16 kHz y produce frames exactos de 20 ms.
3. `voice-transport.worker.js` agrega la cabecera `HAI1`, secuencia, timestamp y
   envía el frame al servidor por WebSocket.

## Flujo de salida

1. El worker recibe eventos TTS y frames binarios `HAT1`.
2. `playback-worklet.js` conserva la cola, remuestrea y reproduce según el reloj
   del dispositivo.
3. Sólo después de vaciar la cola publica
   `assistant.speech.playback.ended`, permitiendo que el servidor abra el
   seguimiento de conversación en el momento correcto.

Los worklets se comunican directamente con el worker mediante `MessageChannel`
y transfieren `ArrayBuffer`; las muestras no atraviesan la hebra de la GUI.

## Primer inicio

- Abrir el display desde `http://localhost:3000` en desarrollo o mediante HTTPS. La captura de
  micrófono no funciona desde una IP servida por HTTP porque no es un contexto
  seguro.
- La aplicación se conecta al mismo origen que la sirvió; no existe selección ni
  descubrimiento de backend dentro del navegador.
- Autorizar el micrófono cuando Chromium lo solicite.
- La identidad, wake word y dispositivos elegidos quedan guardados en
  `localStorage` del perfil kiosk.

Chromium debe iniciarse con una política de autoplay apropiada para kiosk o el
usuario debe tocar la pantalla una vez. Cada interacción intenta reanudar ambos
`AudioContext` si el navegador los dejó suspendidos.

## Pruebas

```bash
npm run check --workspace @ha/display
npm test --workspace @ha/display
```
