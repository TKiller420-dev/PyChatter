#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PYCHATTER_PUBLIC_HOST="${PYCHATTER_PUBLIC_HOST:-217.216.40.246}"

PY="$ROOT_DIR/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  PY="python3"
fi

if "$PY" - <<'PY' >/dev/null 2>&1
import tkinter
PY
then
  exec "$PY" client/server_control_gui.py "$@"
else
  echo "Tkinter is required for the server control panel."
  echo "Install it with: sudo dnf install -y python3-tkinter"
  exit 1
fi