#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PYCHATTER_WEB_HOST=0.0.0.0
export PYCHATTER_WS_HOST=0.0.0.0

HTTP_PORT=9010
WS_PORT=9011
if ss -ltn "sport = :$HTTP_PORT" 2>/dev/null | grep -q LISTEN; then
  echo "Cannot start web-public bridge: HTTP port $HTTP_PORT is already in use."
  echo "Stop the running bridge first (for example: pkill -f 'server/web_bridge.py')."
  exit 1
fi
if ss -ltn "sport = :$WS_PORT" 2>/dev/null | grep -q LISTEN; then
  echo "Cannot start web-public bridge: WS port $WS_PORT is already in use."
  echo "Stop the running bridge first (for example: pkill -f 'server/web_bridge.py')."
  exit 1
fi

PY="$ROOT_DIR/.venv/bin/python"
if [[ -x "$PY" ]]; then
  exec "$PY" server/web_bridge.py
else
  exec python3 server/web_bridge.py
fi