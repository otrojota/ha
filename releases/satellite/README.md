# Release del satélite web para Raspberry Pi

El satélite no contiene un backend Node ni sirve archivos localmente. Chromium
abre la URL de `apps/server`, donde descarga HTML y JavaScript; esa aplicación
captura el micrófono, transmite PCM al servidor y reproduce el TTS recibido.
El único proceso de audio nativo instalado por este release es el cliente
oficial Sendspin, que registra el parlante en Music Assistant.

## Construcción

Desde la raíz del monorepo:

```bash
./releases/satellite/package.sh
```

El artefacto se crea en `releases/dist/` para Linux ARM64.

## Instalación

En Raspberry Pi OS Lite de 64 bits:

```bash
curl -fsSL https://raw.githubusercontent.com/otrojota/ha/main/releases/satellite/install.sh | sudo sh
```

El instalador configura Chromium Kiosk en el autostart de Labwc y habilita
`ha-satellite.service` para Sendspin. La configuración persistente es:

```text
/etc/ha/satellite.env
```

Configura al menos `SERVER_URL` con el origen HTTP o HTTPS del servidor. El
kiosco exige que HTTPS tenga un certificado confiable. Para una CA privada se
puede pasar `HA_SERVER_CA_FILE` al instalador; éste la registra tanto en Debian
como en el almacén NSS de Chromium, sin pedir aceptación manual. Los dispositivos
de micrófono y salida TTS se eligen en la aplicación web y quedan
guardados por el navegador. La salida musical de Sendspin se configura con sus
variables opcionales en el mismo archivo.

En Raspberry Pi OS el kiosco desactiva la ruta de cámara PipeWire de Chromium.
En instalaciones Lite sin `xdg-desktop-portal`, esa ruta puede bloquear
`enumerateDevices()` y ocultar también los dispositivos de audio. La aplicación
no utiliza cámara; la captura y reproducción de audio continúan por PipeWire.

## Diagnóstico

```bash
/opt/ha/current/health-check.sh
sudo systemctl status ha-satellite --no-pager
sudo journalctl -u ha-satellite -f
```
