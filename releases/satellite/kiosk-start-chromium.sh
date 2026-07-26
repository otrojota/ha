#!/bin/sh
set -eu

if [ -f /etc/ha/satellite.env ]; then
  set -a
  . /etc/ha/satellite.env
  set +a
fi
PORT=${DISPLAY_PORT:-8080}
until curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; do
  sleep 1
done

exec chromium \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-session-crashed-bubble \
  --lang=es-CL \
  --disable-features=Translate,TranslateUI \
  --password-store=basic \
  --ozone-platform=wayland \
  "http://localhost:$PORT"
