import asyncio
import functools
import http.server
import json
import os
import pathlib
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime
from typing import Any
from urllib.parse import urlparse

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from store import ChatStore

DB_PATH = pathlib.Path(__file__).resolve().parent / "chat.db"
ADMIN_HOST = os.environ.get("PYCHATTER_ADMIN_HOST", "127.0.0.1")
ADMIN_PORT = int(os.environ.get("PYCHATTER_ADMIN_PORT", "9020"))
DASHBOARD_ROOT = pathlib.Path(__file__).resolve().parent.parent / "admin"
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8765

console_logs = []
console_lock = threading.Lock()


def add_log(msg: str, level: str = "info") -> None:
    global console_logs
    with console_lock:
        console_logs.append({
            "message": msg,
            "level": level,
            "timestamp": int(time.time())
        })
        if len(console_logs) > 500:
            console_logs = console_logs[-500:]


class AdminHandler(http.server.SimpleHTTPRequestHandler):
    _store = None

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(DASHBOARD_ROOT), **kwargs)
        if AdminHandler._store is None:
            AdminHandler._store = ChatStore(str(DB_PATH))

    def _send_json(self, data: Any, status: int = 200) -> None:
        payload = json.dumps(data, separators=(",", ":"), default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _get_admin_stats(self) -> None:
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
                SELECT id, username, role, is_online, created_at, last_seen_at
                FROM users ORDER BY username ASC
            """).fetchall()

            users = [{
                "id": row["id"],
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
                SELECT c.id, c.name, c.created_at, COUNT(cm.id) as msg_count, COUNT(DISTINCT cm.author) as user_count
                FROM channels c
                LEFT JOIN channel_messages cm ON c.name = cm.channel
                GROUP BY c.name ORDER BY c.name ASC
            """).fetchall()

            channels = [{
                "id": row["id"],
                "name": row["name"],
                "messageCount": row["msg_count"] or 0,
                "userCount": row["user_count"] or 0,
                "created": row["created_at"],
            } for row in rows]
        self._send_json({"channels": channels})

    def _create_channel(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON"}, 400)
            return

        name = data.get("name", "").strip().lower().replace(" ", "-")[:32]
        if not name:
            self._send_json({"error": "Channel name is required"}, 400)
            return

        store = AdminHandler._store
        store.ensure_channel(name)
        add_log(f"Channel created via admin: #{name}", "success")
        self._send_json({"success": True, "message": f"Channel #{name} created"})

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
                "metadata": json.loads(row["metadata_json"]) if row["metadata_json"] else {},
                "timestamp": row["created_at"],
            } for row in rows]
        self._send_json({"events": events})

    def _get_voice_rooms(self) -> None:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            rows = cursor.execute("""
                SELECT id, name, created_by, created_at FROM voice_rooms ORDER BY name ASC
            """).fetchall()

            rooms = [{
                "id": row["id"],
                "name": row["name"],
                "createdBy": row["created_by"],
                "created": row["created_at"],
            } for row in rows]
        self._send_json({"rooms": rooms})

    def _set_user_role(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON"}, 400)
            return

        username = data.get("username", "").strip().lower()
        new_role = data.get("role", "").strip().lower()
        if new_role not in ("member", "mod", "admin"):
            self._send_json({"error": "Invalid role"}, 400)
            return

        store = AdminHandler._store
        if store.set_user_role(username, new_role):
            add_log(f"User role updated: {username} -> {new_role}", "success")
            self._send_json({"success": True, "message": f"Updated {username} to {new_role}"})
        else:
            self._send_json({"error": "User not found"}, 404)

    def _delete_message(self, msg_id: str) -> None:
        try:
            msg_id = int(msg_id)
        except (ValueError, TypeError):
            self._send_json({"error": "Invalid message ID"}, 400)
            return

        store = AdminHandler._store
        ok, channel, error = store.delete_message(msg_id, "admin", "admin")
        if ok:
            add_log(f"Message deleted: {msg_id} from {channel}", "warning")
            self._send_json({"success": True, "message": "Message deleted"})
        else:
            self._send_json({"error": error}, 400)

    def _check_server_status(self) -> None:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1)
            result = sock.connect_ex((SERVER_HOST, SERVER_PORT))
            sock.close()
            is_running = result == 0
        except Exception:
            is_running = False

        uptime = ""
        try:
            out = subprocess.run(
                ["systemctl", "show", "pychatter-server.service", "--property=ActiveEnterTimestamp"],
                capture_output=True, text=True, timeout=5,
            ).stdout.strip()
            ts = out.split("=", 1)[1].strip() if "=" in out else ""
            if ts:
                started = datetime.strptime(ts, "%a %Y-%m-%d %H:%M:%S %Z")
                delta = datetime.now() - started
                hours, remainder = divmod(int(delta.total_seconds()), 3600)
                minutes = remainder // 60
                uptime = f"{hours}h {minutes}m"
        except Exception:
            uptime = ""

        self._send_json({
            "running": is_running,
            "host": SERVER_HOST,
            "port": SERVER_PORT,
            "uptime": uptime,
        })

    def _get_console_logs(self) -> None:
        with console_lock:
            self._send_json({"logs": console_logs[-100:]})

    # server.py and web_bridge.py both run as real systemd units
    # (pychatter-server.service / pychatter-web.service, User=pychatter,
    # Restart=always). admin_server.py runs as that same pychatter user, and
    # a scoped sudoers rule (/etc/sudoers.d/pychatter-service-control) grants
    # it NOPASSWD access to exactly `systemctl {restart,stop,start,is-active}
    # pychatter-server.service` — nothing else. We manage the unit through
    # systemctl rather than killing/respawning the PID directly, because
    # systemd's own Restart=always would otherwise race a manual respawn and
    # produce two processes fighting over the same port.
    def _systemctl(self, action: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["sudo", "-n", "systemctl", action, "pychatter-server.service"],
            capture_output=True,
            text=True,
            timeout=15,
        )

    def _wait_for_port(self, tries: int = 25, delay: float = 0.2) -> bool:
        for _ in range(tries):
            time.sleep(delay)
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(0.3)
            if sock.connect_ex((SERVER_HOST, SERVER_PORT)) == 0:
                sock.close()
                return True
            sock.close()
        return False

    def _restart_server(self) -> None:
        add_log("Restarting pychatter-server.service...", "warning")
        result = self._systemctl("restart")
        if result.returncode != 0:
            err = (result.stderr or result.stdout).strip()
            add_log(f"systemctl restart failed: {err}", "error")
            self._send_json({"error": err or "systemctl restart failed"}, 500)
            return
        if self._wait_for_port():
            add_log("Server restarted and is accepting connections", "success")
            self._send_json({"success": True, "message": "Server restarted"})
        else:
            add_log("Restart issued but port 8765 is not yet accepting connections", "warning")
            self._send_json({"success": True, "message": "Restart issued, server is still starting"})

    def _stop_server(self) -> None:
        add_log("Stopping pychatter-server.service...", "warning")
        result = self._systemctl("stop")
        if result.returncode != 0:
            err = (result.stderr or result.stdout).strip()
            add_log(f"systemctl stop failed: {err}", "error")
            self._send_json({"error": err or "systemctl stop failed"}, 500)
            return
        add_log("Server stopped", "success")
        self._send_json({"success": True, "message": "Server stopped"})

    def _start_server(self) -> None:
        add_log("Starting pychatter-server.service...", "info")
        result = self._systemctl("start")
        if result.returncode != 0:
            err = (result.stderr or result.stdout).strip()
            add_log(f"systemctl start failed: {err}", "error")
            self._send_json({"error": err or "systemctl start failed"}, 500)
            return
        if self._wait_for_port():
            add_log("Server started", "success")
            self._send_json({"success": True, "message": "Server started"})
        else:
            add_log("Start issued but port 8765 is not yet accepting connections", "warning")
            self._send_json({"success": True, "message": "Server starting"})

    def _ban_user(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body.decode("utf-8")) if body else {}
            username = data.get("username", "").strip().lower()
            reason = data.get("reason", "No reason provided")

            if not username:
                self._send_json({"error": "Username required"}, 400)
                return

            add_log(f"User banned: {username} ({reason})", "error")
            self._send_json({"success": True, "message": f"{username} has been banned"})
        except Exception as e:
            self._send_json({"error": str(e)}, 400)

    def _mute_user(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body.decode("utf-8")) if body else {}
            username = data.get("username", "").strip().lower()
            duration = data.get("duration", 3600)

            if not username:
                self._send_json({"error": "Username required"}, 400)
                return

            add_log(f"User muted: {username} for {duration}s", "warning")
            self._send_json({"success": True, "message": f"{username} has been muted"})
        except Exception as e:
            self._send_json({"error": str(e)}, 400)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/stats":
            self._get_admin_stats()
            return
        if parsed.path == "/api/users":
            self._get_users()
            return
        if parsed.path == "/api/channels":
            self._get_channels()
            return
        if parsed.path == "/api/audit-logs":
            self._get_audit_logs()
            return
        if parsed.path == "/api/voice-rooms":
            self._get_voice_rooms()
            return
        if parsed.path == "/api/server/status":
            self._check_server_status()
            return
        if parsed.path == "/api/console/logs":
            self._get_console_logs()
            return

        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/users/role":
            self._set_user_role()
            return

        if parsed.path == "/api/users/ban":
            self._ban_user()
            return

        if parsed.path == "/api/users/mute":
            self._mute_user()
            return

        if parsed.path == "/api/channels/create":
            self._create_channel()
            return

        if parsed.path.startswith("/api/messages/"):
            parts = parsed.path.split("/")
            if len(parts) >= 4 and parts[4] == "delete":
                msg_id = parts[3]
                self._delete_message(msg_id)
                return

        if parsed.path == "/api/server/restart":
            self._restart_server()
            return

        if parsed.path == "/api/server/stop":
            self._stop_server()
            return

        if parsed.path == "/api/server/start":
            self._start_server()
            return

        self._send_json({"error": "Not found"}, 404)

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def main() -> None:
    DASHBOARD_ROOT.mkdir(exist_ok=True)
    add_log("PyChatter Admin Dashboard started", "success")

    handler = functools.partial(AdminHandler)
    server = http.server.ThreadingHTTPServer((ADMIN_HOST, ADMIN_PORT), handler)
    print(f"PyChatter Admin Dashboard: http://{ADMIN_HOST}:{ADMIN_PORT}")
    print(f"Serving from: {DASHBOARD_ROOT}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        add_log("Admin dashboard shutdown", "warning")
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
