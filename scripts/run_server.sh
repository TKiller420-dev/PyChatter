#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PYCHATTER_PORT:-8765}"
if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
  echo "Cannot start chat server: port $PORT is already in use."
  echo "Stop the running instance first (for example: pkill -f 'server/server.py')."
  exit 1
fi

PY="$ROOT_DIR/.venv/bin/python"
if [[ -x "$PY" ]]; then
  exec "$PY" server/server.py
else
  exec python3 server/server.py
fi
