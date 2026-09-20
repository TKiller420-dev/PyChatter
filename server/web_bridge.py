import asyncio
import base64
import functools
import hmac
import html
import http.server
import json
import os
import pathlib
import sqlite3
import sys
import threading
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

import websockets

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from shared.protocol import decode_packet, encode_packet
from store import ChatStore, VALID_ROLES, normalize_role


WEB_ROOT = pathlib.Path(__file__).resolve().parent.parent / "web"
DB_PATH = pathlib.Path(__file__).resolve().parent / "chat.db"
HTTP_HOST = os.environ.get("PYCHATTER_WEB_HOST", "127.0.0.1")
HTTP_PORT = int(os.environ.get("PYCHATTER_WEB_PORT", "9010"))
WS_HOST = os.environ.get("PYCHATTER_WS_HOST", "127.0.0.1")
WS_PORT = int(os.environ.get("PYCHATTER_WS_PORT", "9011"))
BACKEND_HOST = os.environ.get("PYCHATTER_BACKEND_HOST", "127.0.0.1")
BACKEND_PORT = int(os.environ.get("PYCHATTER_BACKEND_PORT", "8765"))
DB_VIEW_TOKEN = os.environ.get("PYCHATTER_DB_VIEW_TOKEN", "")
DB_VIEW_MAX_LIMIT = max(1, int(os.environ.get("PYCHATTER_DB_VIEW_MAX_LIMIT", "100")))


def build_ice_servers() -> list[dict[str, Any]]:
    env_json = os.environ.get("PYCHATTER_ICE_SERVERS", "").strip()
    if env_json:
        try:
            parsed = json.loads(env_json)
            if isinstance(parsed, list):
                return [entry for entry in parsed if isinstance(entry, dict) and "urls" in entry]
        except json.JSONDecodeError:
            pass

    servers: list[dict[str, Any]] = [{"urls": "stun:stun.l.google.com:19302"}]
    turn_url = os.environ.get("PYCHATTER_TURN_URL", "").strip()
    turn_user = os.environ.get("PYCHATTER_TURN_USERNAME", "").strip()
    turn_secret = os.environ.get("PYCHATTER_TURN_SECRET", "").strip()
    turn_pass = os.environ.get("PYCHATTER_TURN_PASSWORD", "").strip()
    turn_urls: str | list[str] = turn_url
    if turn_url and turn_url.startswith("turn:") and "transport=" not in turn_url:
        turn_urls = [f"{turn_url}?transport=udp", f"{turn_url}?transport=tcp"]
    if turn_url and turn_secret:
        ttl_seconds = max(60, int(os.environ.get("PYCHATTER_TURN_TTL_SECONDS", "3600")))
        username = f"{int(time.time()) + ttl_seconds}:{turn_user or 'pychatter'}"
        credential = base64.b64encode(
            hmac.digest(turn_secret.encode("utf-8"), username.encode("utf-8"), "sha1")
        ).decode("ascii")
        servers.append(
            {
                "urls": turn_urls,
                "username": username,
                "credential": credential,
            }
        )
    elif turn_url and turn_user and turn_pass:
        servers.append(
            {
                "urls": turn_urls,
                "username": turn_user,
                "credential": turn_pass,
            }
        )
    return servers


def load_db_tables() -> list[str]:
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    return [row[0] for row in rows]


def quote_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def fetch_db_table(table: str, limit: int) -> tuple[list[str], list[sqlite3.Row]]:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        columns = [
            row[1]
            for row in conn.execute(f"PRAGMA table_info({quote_identifier(table)})").fetchall()
        ]
        rows = conn.execute(
            f"SELECT * FROM {quote_identifier(table)} ORDER BY 1 DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return columns, rows


def render_db_viewer(selected_table: str, token: str, limit: int) -> str:
    tables = load_db_tables()
    if not tables:
        body = "<p>No tables found.</p>"
        selected_table = ""
    else:
        if selected_table not in tables:
            selected_table = tables[0]
        columns, rows = fetch_db_table(selected_table, limit)
        header_cells = "".join(f"<th>{html.escape(col)}</th>" for col in columns)
        row_html = []
        for row in rows:
            cells = "".join(
                f"<td><pre>{html.escape(json.dumps(row[col], ensure_ascii=True, default=str, indent=2) if isinstance(row[col], (dict, list)) else str(row[col]))}</pre></td>"
                for col in columns
            )
            row_html.append(f"<tr>{cells}</tr>")
        rows_markup = "\n".join(row_html) or f"<tr><td colspan=\"{max(1, len(columns))}\">No rows yet.</td></tr>"
        body = f"""
        <div class=\"meta\">Showing up to {limit} rows from <strong>{html.escape(selected_table)}</strong></div>
        <table>
          <thead><tr>{header_cells}</tr></thead>
          <tbody>{rows_markup}</tbody>
        </table>
        """

    nav_links = "\n".join(
        f'<a class="table-link{" active" if table == selected_table else ""}" href="/_db?token={html.escape(token)}&table={html.escape(table)}&limit={limit}">{html.escape(table)}</a>'
        for table in tables
    ) or "<span class=\"table-link active\">No tables</span>"

    return f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>PyChatter DB Viewer</title>
  <style>
    :root {{
      --bg: #0f172a;
      --panel: #111827;
      --line: #253047;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --accent: #22c55e;
      --accent-2: #16a34a;
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; font-family: "Trebuchet MS", "Segoe UI", sans-serif; background: linear-gradient(160deg, #09101f, #0f172a 40%, #132033); color: var(--text); }}
    .layout {{ min-height: 100vh; display: grid; grid-template-columns: 260px 1fr; }}
    .sidebar {{ padding: 20px; border-right: 1px solid var(--line); background: rgba(8, 15, 29, 0.85); }}
    .content {{ padding: 20px; overflow-x: auto; }}
    h1 {{ margin: 0 0 10px; font-size: 1.5rem; }}
    p, .meta {{ color: var(--muted); }}
    .table-list {{ display: grid; gap: 8px; margin-top: 18px; }}
    .table-link {{ display: block; color: var(--text); text-decoration: none; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: rgba(17, 24, 39, 0.75); }}
    .table-link.active {{ border-color: var(--accent); background: rgba(34, 197, 94, 0.12); }}
    .toolbar {{ display: flex; gap: 12px; align-items: center; margin: 0 0 16px; flex-wrap: wrap; }}
    .toolbar input {{ border: 1px solid var(--line); border-radius: 10px; background: #0b1220; color: var(--text); padding: 10px 12px; width: 110px; }}
    .toolbar button {{ border: 0; border-radius: 10px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #06220f; font-weight: 800; padding: 10px 14px; cursor: pointer; }}
    table {{ width: 100%; border-collapse: collapse; min-width: 700px; background: rgba(10, 18, 32, 0.88); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }}
    th, td {{ vertical-align: top; padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; }}
    th {{ position: sticky; top: 0; background: #122033; }}
    pre {{ margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }}
    code {{ color: #bfdbfe; }}
    @media (max-width: 900px) {{ .layout {{ grid-template-columns: 1fr; }} .sidebar {{ border-right: 0; border-bottom: 1px solid var(--line); }} }}
  </style>
</head>
<body>
  <div class=\"layout\">
    <aside class=\"sidebar\">
      <h1>PyChatter DB</h1>
      <p>Read-only SQLite viewer for <code>{html.escape(str(DB_PATH))}</code>.</p>
      <div class=\"table-list\">{nav_links}</div>
    </aside>
    <main class=\"content\">
      <form class=\"toolbar\" method=\"get\" action=\"/_db\">
        <input type=\"hidden\" name=\"token\" value=\"{html.escape(token)}\">
        <input type=\"hidden\" name=\"table\" value=\"{html.escape(selected_table)}\">
        <label>Rows <input type=\"number\" min=\"1\" max=\"{DB_VIEW_MAX_LIMIT}\" name=\"limit\" value=\"{limit}\"></label>
        <button type=\"submit\">Reload</button>
      </form>
      {body}
    </main>
  </div>
</body>
</html>
"""


class PyChatterHandler(http.server.SimpleHTTPRequestHandler):
    _store = None

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)
        if PyChatterHandler._store is None:
            PyChatterHandler._store = ChatStore(str(DB_PATH))

    def _send_json(self, data: Any, status: int = 200) -> None:
        payload = json.dumps(data, separators=(",", ":"), default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _get_admin_stats(self) -> None:
        store = PyChatterHandler._store
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            total_users = cursor.execute("SELECT COUNT(*) as n FROM users").fetchone()["n"]
            online_users = cursor.execute("SELECT COUNT(*) as n FROM users WHERE is_online = 1").fetchone()["n"]
            total_channels = cursor.execute("SELECT COUNT(*) as n FROM channels").fetchone()["n"]
            total_messages = cursor.execute("SELECT COUNT(*) as n FROM channel_messages").fetchone()["n"]
            active_voice_rooms = cursor.execute("SELECT COUNT(*) as n FROM voice_rooms").fetchone()["n"]

            data = {
                "onlineUsers": online_users,
                "totalUsers": total_users,
                "activeChannels": total_channels,
                "totalMessages": total_messages,
                "activeVoiceRooms": active_voice_rooms,
            }
        self._send_json(data)

    def _get_users(self) -> None:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            rows = cursor.execute("""
                SELECT username, role, is_online, created_at, last_seen_at
                FROM users ORDER BY username ASC
            """).fetchall()

            users = [{
                "username": row["username"],
                "role": row["role"],
                "isOnline": bool(row["is_online"]),
                "created": row["created_at"],
                "lastSeen": row["last_seen_at"],
            } for row in rows]
        self._send_json({"users": users})

    def _get_channels(self) -> None:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            rows = cursor.execute("""
                SELECT c.name, c.created_at, COUNT(cm.id) as msg_count, COUNT(DISTINCT cm.author) as user_count
                FROM channels c
                LEFT JOIN channel_messages cm ON c.name = cm.channel
                GROUP BY c.name ORDER BY c.name ASC
            """).fetchall()

            channels = [{
                "name": row["name"],
                "messageCount": row["msg_count"] or 0,
                "userCount": row["user_count"] or 0,
                "created": row["created_at"],
            } for row in rows]
        self._send_json({"channels": channels})

    def _get_audit_logs(self) -> None:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            rows = cursor.execute("""
                SELECT id, event_type, actor, target, channel, metadata_json, created_at
                FROM audit_events ORDER BY created_at DESC LIMIT 100
            """).fetchall()

            events = [{
                "id": row["id"],
                "type": row["event_type"],
                "actor": row["actor"],
                "target": row["target"],
                "channel": row["channel"],
                "metadata": json.loads(row["metadata_json"]),
                "timestamp": row["created_at"],
            } for row in rows]
        self._send_json({"events": events})

    def _get_voice_rooms(self) -> None:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            rows = cursor.execute("""
                SELECT name, created_by, created_at FROM voice_rooms ORDER BY name ASC
            """).fetchall()

            rooms = [{
                "name": row["name"],
                "createdBy": row["created_by"],
                "created": row["created_at"],
            } for row in rows]
        self._send_json({"rooms": rooms})

    def _set_user_role(self, username: str, new_role: str) -> None:
        new_role = normalize_role(new_role)
        if new_role not in VALID_ROLES:
            self._send_json({"error": "Invalid role"}, 400)
            return

        store = PyChatterHandler._store
        if store.set_user_role(username, new_role):
            self._send_json({"success": True, "message": f"Updated {username} to {new_role}"})
        else:
            self._send_json({"error": "User not found"}, 404)

    def _delete_message(self, msg_id: str) -> None:
        try:
            msg_id = int(msg_id)
        except (ValueError, TypeError):
            self._send_json({"error": "Invalid message ID"}, 400)
            return

        store = PyChatterHandler._store
        ok, channel, error = store.delete_message(msg_id, "admin", "admin")
        if ok:
            self._send_json({"success": True, "message": "Message deleted"})
        else:
            self._send_json({"error": error}, 400)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/admin/stats":
            self._get_admin_stats()
            return
        if parsed.path == "/api/admin/users":
            self._get_users()
            return
        if parsed.path == "/api/admin/channels":
            self._get_channels()
            return
        if parsed.path == "/api/admin/audit-logs":
            self._get_audit_logs()
            return
        if parsed.path == "/api/admin/voice-rooms":
            self._get_voice_rooms()
            return

        if parsed.path == "/_rtc_config":
            payload = json.dumps({"iceServers": build_ice_servers()}, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if parsed.path == "/_db":
            # Public DB viewer removed for security hardening.
            self.send_error(404)
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON"}, 400)
            return

        if parsed.path == "/api/admin/users/role":
            username = data.get("username", "").strip().lower()
            role = data.get("role", "").strip().lower()
            self._set_user_role(username, role)
            return

        if parsed.path.startswith("/api/admin/messages/"):
            parts = parsed.path.split("/")
            if len(parts) >= 4 and parts[4] == "delete":
                msg_id = parts[3]
                self._delete_message(msg_id)
                return

        self._send_json({"error": "Not found"}, 404)

    def handle_db_view(self, parsed: Any) -> None:
        if not DB_VIEW_TOKEN:
            self.send_error(404)
            return

        params = parse_qs(parsed.query)
        token = params.get("token", [""])[0]
        if token != DB_VIEW_TOKEN:
            self.send_response(403)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Forbidden")
            return

        table = params.get("table", [""])[0]
        try:
            limit = int(params.get("limit", [str(DB_VIEW_MAX_LIMIT)])[0])
        except ValueError:
            limit = DB_VIEW_MAX_LIMIT
        limit = max(1, min(limit, DB_VIEW_MAX_LIMIT))

        page = render_db_viewer(table, token, limit).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)


def start_http_server() -> None:
    handler = functools.partial(PyChatterHandler)
    server = http.server.ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()


async def browser_to_tcp(ws: Any, tcp_writer: asyncio.StreamWriter):
    try:
        async for raw in ws:
            if not isinstance(raw, str):
                continue
            tcp_writer.write((raw + "\n").encode("utf-8"))
            await tcp_writer.drain()
    finally:
        try:
            tcp_writer.close()
            await tcp_writer.wait_closed()
        except Exception:
            pass


async def tcp_to_browser(ws: Any, tcp_reader: asyncio.StreamReader):
    try:
        while True:
            line = await tcp_reader.readline()
            if not line:
                await ws.send('{"type":"system","message":"Disconnected from chat server."}')
                break
            packet = decode_packet(line)
            await ws.send(__import__("json").dumps(packet))
    finally:
        await ws.close()


async def ws_handler(ws: Any):
    try:
        reader, writer = await asyncio.open_connection(
            BACKEND_HOST, BACKEND_PORT, limit=2 * 1024 * 1024
        )
    except OSError as exc:
        await ws.send(f'{{"type":"auth_error","message":"Cannot reach backend server: {exc}"}}')
        await ws.close()
        return

    task_a = asyncio.create_task(browser_to_tcp(ws, writer))
    task_b = asyncio.create_task(tcp_to_browser(ws, reader))
    done, pending = await asyncio.wait({task_a, task_b}, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    for task in done:
        try:
            task.result()
        except Exception:
            pass


async def main() -> None:
    try:
        start_http_server()
    except OSError as exc:
        if exc.errno == 98:
            print(
                f"Cannot start web UI on {HTTP_HOST}:{HTTP_PORT}: address already in use. "
                "Another instance is likely already running."
            )
            return
        raise
    print(f"Web UI: http://{HTTP_HOST}:{HTTP_PORT}")
    print(f"WebSocket bridge: ws://{WS_HOST}:{WS_PORT}/ws")
    print(f"Backend target: {BACKEND_HOST}:{BACKEND_PORT}")
    try:
        async with websockets.serve(
            ws_handler,
            WS_HOST,
            WS_PORT,
            max_size=2**20,
        ):
            await asyncio.Future()
    except OSError as exc:
        if exc.errno == 98:
            print(
                f"Cannot start WebSocket bridge on {WS_HOST}:{WS_PORT}: address already in use. "
                "Another instance is likely already running."
            )
            return
        raise


if __name__ == "__main__":
    asyncio.run(main())
