#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PYCHATTER_WEB_HOST=0.0.0.0
export PYCHATTER_WS_HOST=0.0.0.0

TOKEN_FILE="$ROOT_DIR/.db_view_token"
if [[ -z "${PYCHATTER_DB_VIEW_TOKEN:-}" ]]; then
  if [[ ! -f "$TOKEN_FILE" ]]; then
    umask 077
    python3 - <<'PY' > "$TOKEN_FILE"
import secrets
print(secrets.token_urlsafe(24))
PY
  fi
  export PYCHATTER_DB_VIEW_TOKEN="$(<"$TOKEN_FILE")"
fi

echo "DB viewer token file: $TOKEN_FILE"

PY="$ROOT_DIR/.venv/bin/python"
if [[ -x "$PY" ]]; then
  exec "$PY" server/web_bridge.py
else
  exec python3 server/web_bridge.py
fi