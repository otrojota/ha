#!/bin/sh
set -eu

if [ -f /etc/ha/satellite.env ]; then
  set -a
  . /etc/ha/satellite.env
  set +a
fi

SERVER_URL=${SERVER_URL:-http://ha-server:3000}
until curl -fsS "$SERVER_URL/health" >/dev/null 2>&1; do
  sleep 1
done

exec chromium \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-session-crashed-bubble \
  --autoplay-policy=no-user-gesture-required \
  --lang=es-CL \
  --disable-features=Translate,TranslateUI,WebRtcPipeWireCamera \
  --password-store=basic \
  --ozone-platform=wayland \
  "$SERVER_URL/"
