#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PY="$ROOT_DIR/.venv/bin/python"
if [[ -x "$PY" ]]; then
  exec "$PY" server/server.py
fi

exec python3 server/server.py
