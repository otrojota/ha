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

export COG_PLATFORM_NAME=wl
export COG_PLATFORM_WL_VIEW_FULLSCREEN=1
exec cog \
  --webprocess-failure=restart \
  --bg-color='#111827' \
  "http://localhost:$PORT"
