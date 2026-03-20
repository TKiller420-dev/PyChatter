import os
import queue
import socket
import sqlite3
import signal
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import messagebox
from tkinter import ttk


ROOT_DIR = Path(__file__).resolve().parent.parent
RUN_SERVER = ROOT_DIR / "scripts" / "run_server.sh"
RUN_WEB = ROOT_DIR / "scripts" / "run_web.sh"
RUN_WEB_PUBLIC = ROOT_DIR / "scripts" / "run_web_public.sh"
TOKEN_FILE = ROOT_DIR / ".db_view_token"
DB_PATH = ROOT_DIR / "server" / "chat.db"

def _port_is_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _pick_open_port(preferred: int, used: set[int] | None = None) -> int:
    used = used or set()
    if preferred not in used and _port_is_available(preferred):
        return preferred
    for port in range(10000, 65535):
        if port in used:
            continue
        if _port_is_available(port):
            return port
    raise RuntimeError("No free TCP ports found")


class ManagedProcess:
    def __init__(self, name: str, command: list[str], env: dict[str, str] | None = None) -> None:
        self.name = name
        self.command = command
        self.env = env or {}
        self.process: subprocess.Popen[str] | None = None
        self.reader_thread: threading.Thread | None = None

    def is_running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def start(self, log_queue: queue.Queue[tuple[str, str]], extra_env: dict[str, str] | None = None) -> None:
        if self.is_running():
            return
        env = os.environ.copy()
        env.update(self.env)
        if extra_env:
            env.update(extra_env)
        self.process = subprocess.Popen(
            self.command,
            cwd=str(ROOT_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
            preexec_fn=os.setsid,
        )
        self.reader_thread = threading.Thread(
            target=self._pump_output,
            args=(log_queue,),
            daemon=True,
        )
        self.reader_thread.start()

    def _pump_output(self, log_queue: queue.Queue[tuple[str, str]]) -> None:
        assert self.process is not None
        assert self.process.stdout is not None
        for line in self.process.stdout:
            log_queue.put((self.name, line.rstrip()))
        code = self.process.poll()
        log_queue.put((self.name, f"[process exited with code {code}]") )

    def stop(self, log_queue: queue.Queue[tuple[str, str]]) -> None:
        if not self.is_running() or self.process is None:
            return
        try:
            os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
            log_queue.put((self.name, "[sent SIGTERM]"))
        except ProcessLookupError:
            pass

    def kill(self, log_queue: queue.Queue[tuple[str, str]]) -> None:
        if not self.is_running() or self.process is None:
            return
        try:
            os.killpg(os.getpgid(self.process.pid), signal.SIGKILL)
            log_queue.put((self.name, "[sent SIGKILL]"))
        except ProcessLookupError:
            pass


class ServerControlGUI:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("PyChatter Server Control")
        self.root.geometry("1180x760")
        self.root.minsize(980, 640)
        self.root.configure(bg="#0f172a")

        self.log_queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self.server_process = ManagedProcess("server", ["bash", str(RUN_SERVER)])
        self.web_local_process = ManagedProcess("web-local", ["bash", str(RUN_WEB)])
        self.web_public_process = ManagedProcess("web-public", ["bash", str(RUN_WEB_PUBLIC)])

        self.status_labels: dict[str, tk.Label] = {}
        self.token_var = tk.StringVar(value=self._read_token())
        self.server_port = int(os.environ.get("PYCHATTER_PORT", "8765"))
        self.web_http_port = int(os.environ.get("PYCHATTER_WEB_PORT", "9010"))
        self.web_ws_port = int(os.environ.get("PYCHATTER_WS_PORT", "9011"))
        self.public_url_var = tk.StringVar(value=f"http://127.0.0.1:{self.web_http_port}")
        self.db_url_var = tk.StringVar(value=self._build_db_url("127.0.0.1"))
        self.db_limit_var = tk.StringVar(value="100")
        self.db_offset_var = tk.StringVar(value="0")
        self.db_status_var = tk.StringVar(value="Database tab ready")
        self._current_view = "logs"
        self._selected_table = ""

        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.after(150, self._poll_logs)
        self.root.after(1000, self._refresh_status)

    def _build_ui(self) -> None:
        shell = tk.Frame(self.root, bg="#0f172a")
        shell.pack(fill="both", expand=True)

        sidebar = tk.Frame(shell, bg="#111827", width=320)
        sidebar.pack(side="left", fill="y")
        sidebar.pack_propagate(False)

        main = tk.Frame(shell, bg="#0b1220")
        main.pack(side="left", fill="both", expand=True)

        tk.Label(
            sidebar,
            text="PyChatter Control",
            bg="#111827",
            fg="#f8fafc",
            font=("Segoe UI", 18, "bold"),
        ).pack(anchor="w", padx=18, pady=(18, 8))

        tk.Label(
            sidebar,
            text="Start, stop, restart, and watch logs for the chat backend and web host.",
            bg="#111827",
            fg="#94a3b8",
            justify="left",
            wraplength=270,
            font=("Segoe UI", 10),
        ).pack(anchor="w", padx=18, pady=(0, 16))

        self._add_process_card(
            sidebar,
            key="server",
            title="Chat Server",
            subtitle="TCP backend (auto-selects open port)",
            start_command=self.start_server,
            restart_command=self.restart_server,
            stop_command=self.stop_server,
        )
        self._add_process_card(
            sidebar,
            key="web-local",
            title="Web Host",
            subtitle="Local-only UI (auto-selects open port)",
            start_command=self.start_web_local,
            restart_command=self.restart_web_local,
            stop_command=self.stop_web_local,
        )
        self._add_process_card(
            sidebar,
            key="web-public",
            title="Public Web Host",
            subtitle="Public UI and DB viewer (auto-selects open port)",
            start_command=self.start_web_public,
            restart_command=self.restart_web_public,
            stop_command=self.stop_web_public,
        )

        actions = tk.Frame(sidebar, bg="#111827")
        actions.pack(fill="x", padx=18, pady=(8, 18))

        tk.Button(
            actions,
            text="Start Server + Public Web",
            command=self.start_server_and_public,
            bg="#22c55e",
            fg="#06220f",
            activebackground="#16a34a",
            relief="flat",
            font=("Segoe UI", 10, "bold"),
            pady=10,
        ).pack(fill="x", pady=(0, 8))

        tk.Button(
            actions,
            text="Stop All",
            command=self.stop_all,
            bg="#334155",
            fg="#f8fafc",
            activebackground="#475569",
            relief="flat",
            font=("Segoe UI", 10, "bold"),
            pady=10,
        ).pack(fill="x")

        info = tk.LabelFrame(
            sidebar,
            text="Access",
            bg="#111827",
            fg="#e2e8f0",
            bd=1,
            relief="groove",
            font=("Segoe UI", 10, "bold"),
        )
        info.pack(fill="x", padx=18, pady=(0, 18))

        self._add_readonly_field(info, "Web URL", self.public_url_var)
        self._add_readonly_field(info, "DB URL", self.db_url_var)
        self._add_readonly_field(info, "DB Token", self.token_var)

        tk.Button(
            info,
            text="Refresh Token",
            command=self.refresh_token,
            bg="#1d4ed8",
            fg="#eff6ff",
            activebackground="#1e40af",
            relief="flat",
            pady=8,
        ).pack(fill="x", padx=10, pady=(2, 10))

        view_switch = tk.Frame(main, bg="#0b1220")
        view_switch.pack(fill="x", padx=18, pady=(18, 8))
        self.logs_view_btn = tk.Button(
            view_switch,
            text="Live Logs",
            command=lambda: self._switch_view("logs"),
            bg="#2563eb",
            fg="#eff6ff",
            activebackground="#1e40af",
            relief="flat",
            padx=14,
            pady=8,
        )
        self.logs_view_btn.pack(side="left", padx=(0, 8))
        self.db_view_btn = tk.Button(
            view_switch,
            text="Database",
            command=lambda: self._switch_view("db"),
            bg="#1e293b",
            fg="#e2e8f0",
            activebackground="#334155",
            relief="flat",
            padx=14,
            pady=8,
        )
        self.db_view_btn.pack(side="left")

        self.view_container = tk.Frame(main, bg="#0b1220")
        self.view_container.pack(fill="both", expand=True)

        self.logs_view = tk.Frame(self.view_container, bg="#0b1220")
        self.db_view = tk.Frame(self.view_container, bg="#0b1220")

        self._build_logs_view(self.logs_view)
        self._build_db_view(self.db_view)
        self._switch_view("logs")

    def _build_logs_view(self, parent: tk.Frame) -> None:
        header = tk.Frame(parent, bg="#0b1220")
        header.pack(fill="x", padx=18, pady=(0, 10))

        tk.Label(
            header,
            text="Process Logs",
            bg="#0b1220",
            fg="#f8fafc",
            font=("Segoe UI", 16, "bold"),
        ).pack(side="left")

        tk.Button(
            header,
            text="Clear Log",
            command=self.clear_log,
            bg="#1e293b",
            fg="#e2e8f0",
            activebackground="#334155",
            relief="flat",
            padx=16,
            pady=8,
        ).pack(side="right")

        self.log_text = tk.Text(
            parent,
            bg="#020617",
            fg="#e2e8f0",
            insertbackground="#e2e8f0",
            relief="flat",
            borderwidth=0,
            highlightthickness=0,
            font=("Consolas", 11),
            wrap="word",
        )
        self.log_text.pack(fill="both", expand=True, padx=18, pady=(0, 18))
        self.log_text.insert("end", "PyChatter control panel ready.\n")
        self.log_text.insert("end", "Use Start Server + Public Web for the common desktop flow.\n")
        self.log_text.configure(state="disabled")

    def _build_db_view(self, parent: tk.Frame) -> None:
        wrap = tk.Frame(parent, bg="#0b1220")
        wrap.pack(fill="both", expand=True, padx=18, pady=(0, 18))

        left = tk.Frame(wrap, bg="#0f172a", bd=1, relief="groove", width=250)
        left.pack(side="left", fill="y")
        left.pack_propagate(False)

        tk.Label(
            left,
            text="Database Tables",
            bg="#0f172a",
            fg="#f8fafc",
            font=("Segoe UI", 12, "bold"),
        ).pack(anchor="w", padx=10, pady=(10, 6))

        tk.Button(
            left,
            text="Refresh Tables",
            command=self.refresh_db_tables,
            bg="#1d4ed8",
            fg="#eff6ff",
            activebackground="#1e40af",
            relief="flat",
            padx=10,
            pady=6,
        ).pack(fill="x", padx=10, pady=(0, 8))

        self.table_list = tk.Listbox(
            left,
            bg="#020617",
            fg="#e2e8f0",
            selectbackground="#2563eb",
            selectforeground="#eff6ff",
            relief="flat",
            borderwidth=0,
            highlightthickness=0,
            font=("Consolas", 10),
        )
        self.table_list.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        self.table_list.bind("<<ListboxSelect>>", self._on_table_selected)

        right = tk.Frame(wrap, bg="#0b1220")
        right.pack(side="left", fill="both", expand=True, padx=(12, 0))

        top = tk.Frame(right, bg="#0b1220")
        top.pack(fill="x", pady=(0, 10))

        tk.Label(top, text="Limit", bg="#0b1220", fg="#94a3b8", font=("Segoe UI", 9, "bold")).pack(side="left")
        tk.Entry(top, textvariable=self.db_limit_var, width=6, relief="flat", bg="#0f172a", fg="#e2e8f0").pack(side="left", padx=(6, 12), ipady=4)
        tk.Label(top, text="Offset", bg="#0b1220", fg="#94a3b8", font=("Segoe UI", 9, "bold")).pack(side="left")
        tk.Entry(top, textvariable=self.db_offset_var, width=8, relief="flat", bg="#0f172a", fg="#e2e8f0").pack(side="left", padx=(6, 12), ipady=4)

        tk.Button(
            top,
            text="Browse Table",
            command=self.browse_selected_table,
            bg="#334155",
            fg="#f8fafc",
            activebackground="#475569",
            relief="flat",
            padx=12,
            pady=6,
        ).pack(side="left")

        sql_box = tk.Frame(right, bg="#111827", bd=1, relief="groove")
        sql_box.pack(fill="x", pady=(0, 10))

        tk.Label(
            sql_box,
            text="SQL Writer (SELECT/INSERT/UPDATE/DELETE)",
            bg="#111827",
            fg="#e2e8f0",
            font=("Segoe UI", 10, "bold"),
        ).pack(anchor="w", padx=10, pady=(8, 6))

        self.sql_text = tk.Text(
            sql_box,
            height=5,
            bg="#020617",
            fg="#e2e8f0",
            insertbackground="#e2e8f0",
            relief="flat",
            borderwidth=0,
            highlightthickness=0,
            font=("Consolas", 10),
            wrap="word",
        )
        self.sql_text.pack(fill="x", padx=10, pady=(0, 8))
        self.sql_text.insert("1.0", "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")

        sql_actions = tk.Frame(sql_box, bg="#111827")
        sql_actions.pack(fill="x", padx=10, pady=(0, 10))
        tk.Button(
            sql_actions,
            text="Run SQL",
            command=self.execute_sql,
            bg="#22c55e",
            fg="#06220f",
            activebackground="#16a34a",
            relief="flat",
            padx=14,
            pady=7,
        ).pack(side="left")

        tk.Button(
            sql_actions,
            text="Load Selected Table Query",
            command=self.load_selected_table_query,
            bg="#1e293b",
            fg="#e2e8f0",
            activebackground="#334155",
            relief="flat",
            padx=14,
            pady=7,
        ).pack(side="left", padx=(8, 0))

        grid_wrap = tk.Frame(right, bg="#0b1220")
        grid_wrap.pack(fill="both", expand=True)

        self.result_tree = ttk.Treeview(grid_wrap, show="headings")
        self.result_tree.pack(side="left", fill="both", expand=True)
        y_scroll = ttk.Scrollbar(grid_wrap, orient="vertical", command=self.result_tree.yview)
        y_scroll.pack(side="right", fill="y")
        x_scroll = ttk.Scrollbar(right, orient="horizontal", command=self.result_tree.xview)
        x_scroll.pack(fill="x")
        self.result_tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)

        tk.Label(
            right,
            textvariable=self.db_status_var,
            bg="#0b1220",
            fg="#94a3b8",
            anchor="w",
            justify="left",
            font=("Segoe UI", 9),
        ).pack(fill="x", pady=(6, 0))

    def _switch_view(self, name: str) -> None:
        self._current_view = name
        self.logs_view.pack_forget()
        self.db_view.pack_forget()
        if name == "db":
            self.db_view.pack(fill="both", expand=True)
            self.logs_view_btn.config(bg="#1e293b", fg="#e2e8f0")
            self.db_view_btn.config(bg="#2563eb", fg="#eff6ff")
            self.refresh_db_tables()
        else:
            self.logs_view.pack(fill="both", expand=True)
            self.db_view_btn.config(bg="#1e293b", fg="#e2e8f0")
            self.logs_view_btn.config(bg="#2563eb", fg="#eff6ff")

    def _db_connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        return conn

    def _qident(self, name: str) -> str:
        return '"' + name.replace('"', '""') + '"'

    def refresh_db_tables(self) -> None:
        self.table_list.delete(0, "end")
        if not DB_PATH.exists():
            self.db_status_var.set("Database file not found. Start server first.")
            return
        try:
            with self._db_connect() as conn:
                tables = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
                ).fetchall()
                for row in tables:
                    name = str(row["name"])
                    count = conn.execute(f"SELECT COUNT(*) FROM {self._qident(name)}").fetchone()[0]
                    self.table_list.insert("end", f"{name} ({count})")
            self.db_status_var.set("Tables refreshed")
        except Exception as exc:
            self.db_status_var.set(f"Failed to load tables: {exc}")

    def _selected_table_name(self) -> str:
        sel = self.table_list.curselection()
        if not sel:
            return ""
        raw = self.table_list.get(sel[0])
        return str(raw).split(" (", 1)[0]

    def _on_table_selected(self, _event: object) -> None:
        self._selected_table = self._selected_table_name()
        if self._selected_table:
            self.load_selected_table_query()

    def load_selected_table_query(self) -> None:
        name = self._selected_table_name()
        if not name:
            return
        try:
            limit = max(1, int(self.db_limit_var.get().strip() or "100"))
        except ValueError:
            limit = 100
            self.db_limit_var.set("100")
        try:
            offset = max(0, int(self.db_offset_var.get().strip() or "0"))
        except ValueError:
            offset = 0
            self.db_offset_var.set("0")
        q = f"SELECT * FROM {self._qident(name)} LIMIT {limit} OFFSET {offset};"
        self.sql_text.delete("1.0", "end")
        self.sql_text.insert("1.0", q)

    def browse_selected_table(self) -> None:
        self.load_selected_table_query()
        self.execute_sql()

    def _clear_result_grid(self) -> None:
        self.result_tree.delete(*self.result_tree.get_children())
        self.result_tree["columns"] = ()

    def _render_result_grid(self, columns: list[str], rows: list[tuple[object, ...]]) -> None:
        self._clear_result_grid()
        self.result_tree["columns"] = columns
        for col in columns:
            self.result_tree.heading(col, text=col)
            self.result_tree.column(col, width=140, stretch=True, anchor="w")
        for row in rows:
            self.result_tree.insert("", "end", values=["" if v is None else str(v) for v in row])

    def execute_sql(self) -> None:
        sql = self.sql_text.get("1.0", "end").strip()
        if not sql:
            self.db_status_var.set("Enter SQL first")
            return
        if not DB_PATH.exists():
            self.db_status_var.set("Database file not found. Start server first.")
            return
        try:
            with self._db_connect() as conn:
                cur = conn.execute(sql)
                conn.commit()
                if cur.description:
                    columns = [d[0] for d in cur.description]
                    rows = [tuple(r) for r in cur.fetchall()]
                    self._render_result_grid(columns, rows)
                    self.db_status_var.set(f"Query OK: {len(rows)} row(s)")
                else:
                    self._clear_result_grid()
                    affected = cur.rowcount if cur.rowcount is not None else 0
                    self.db_status_var.set(f"Query OK: {affected} row(s) affected")
                    self.refresh_db_tables()
        except Exception as exc:
            self.db_status_var.set(f"SQL error: {exc}")

    def _add_process_card(
        self,
        parent: tk.Widget,
        key: str,
        title: str,
        subtitle: str,
        start_command,
        restart_command,
        stop_command,
    ) -> None:
        card = tk.Frame(parent, bg="#162033", bd=1, relief="groove")
        card.pack(fill="x", padx=18, pady=(0, 12))

        top = tk.Frame(card, bg="#162033")
        top.pack(fill="x", padx=12, pady=(12, 6))
        tk.Label(top, text=title, bg="#162033", fg="#f8fafc", font=("Segoe UI", 12, "bold")).pack(anchor="w")
        tk.Label(top, text=subtitle, bg="#162033", fg="#94a3b8", font=("Segoe UI", 9)).pack(anchor="w", pady=(2, 0))

        status = tk.Label(card, text="Stopped", bg="#162033", fg="#f87171", font=("Segoe UI", 10, "bold"))
        status.pack(anchor="w", padx=12, pady=(0, 8))
        self.status_labels[key] = status

        buttons = tk.Frame(card, bg="#162033")
        buttons.pack(fill="x", padx=12, pady=(0, 12))
        for text, cmd, bg, fg in [
            ("Start", start_command, "#22c55e", "#06220f"),
            ("Restart", restart_command, "#f59e0b", "#1c1917"),
            ("Stop", stop_command, "#ef4444", "#fff1f2"),
        ]:
            tk.Button(
                buttons,
                text=text,
                command=cmd,
                bg=bg,
                fg=fg,
                relief="flat",
                activebackground=bg,
                padx=12,
                pady=8,
            ).pack(side="left", expand=True, fill="x", padx=(0, 6) if text != "Stop" else (0, 0))

    def _add_readonly_field(self, parent: tk.Widget, label: str, variable: tk.StringVar) -> None:
        row = tk.Frame(parent, bg="#111827")
        row.pack(fill="x", padx=10, pady=(10, 0))
        tk.Label(row, text=label, bg="#111827", fg="#94a3b8", font=("Segoe UI", 9, "bold")).pack(anchor="w")
        entry = tk.Entry(row, textvariable=variable, relief="flat", bg="#0b1220", fg="#e2e8f0", readonlybackground="#0b1220")
        entry.pack(fill="x", pady=(4, 0), ipady=7)
        entry.configure(state="readonly")

    def _append_log(self, source: str, message: str) -> None:
        timestamp = time.strftime("%H:%M:%S")
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"[{timestamp}] {source}: {message}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _poll_logs(self) -> None:
        while True:
            try:
                source, message = self.log_queue.get_nowait()
            except queue.Empty:
                break
            self._append_log(source, message)
        self.root.after(150, self._poll_logs)

    def _refresh_status(self) -> None:
        status_map = {
            "server": self.server_process.is_running(),
            "web-local": self.web_local_process.is_running(),
            "web-public": self.web_public_process.is_running(),
        }
        for key, running in status_map.items():
            label = self.status_labels[key]
            label.config(text="Running" if running else "Stopped", fg="#4ade80" if running else "#f87171")
        self.token_var.set(self._read_token())
        self.db_url_var.set(self._build_db_url(self._current_host_for_db()))
        self.public_url_var.set(self._current_web_url())
        self.root.after(1000, self._refresh_status)

    def _read_token(self) -> str:
        if TOKEN_FILE.exists():
            return TOKEN_FILE.read_text(encoding="utf-8").strip()
        return ""

    def _current_host_for_db(self) -> str:
        return "127.0.0.1" if self.web_local_process.is_running() and not self.web_public_process.is_running() else self._resolve_public_host()

    def _current_web_url(self) -> str:
        if self.web_public_process.is_running():
            return f"http://{self._resolve_public_host()}:{self.web_http_port}"
        return f"http://127.0.0.1:{self.web_http_port}"

    def _build_db_url(self, host: str) -> str:
        token = self._read_token()
        if not token:
            return "Start public web host to create a token"
        return f"http://{host}:{self.web_http_port}/_db?token={token}"

    def _resolve_public_host(self) -> str:
        return os.environ.get("PYCHATTER_PUBLIC_HOST", "127.0.0.1")

    def _stop_conflicting_web(self, keep_public: bool) -> None:
        if keep_public:
            self.web_local_process.stop(self.log_queue)
        else:
            self.web_public_process.stop(self.log_queue)

    def start_server(self) -> None:
        if self.server_process.is_running():
            return
        self.server_port = _pick_open_port(8765)
        self._append_log("control", f"Using server port {self.server_port}")
        self.server_process.start(
            self.log_queue,
            {
                "PYCHATTER_PORT": str(self.server_port),
            },
        )

    def restart_server(self) -> None:
        self.server_process.stop(self.log_queue)
        self.root.after(700, self.start_server)

    def stop_server(self) -> None:
        self.server_process.stop(self.log_queue)

    def start_web_local(self) -> None:
        self._stop_conflicting_web(keep_public=False)
        self.web_http_port, self.web_ws_port = self._allocate_web_ports()
        self._append_log("control", f"Using web ports http={self.web_http_port}, ws={self.web_ws_port}")
        self.web_local_process.start(
            self.log_queue,
            {
                "PYCHATTER_WEB_PORT": str(self.web_http_port),
                "PYCHATTER_WS_PORT": str(self.web_ws_port),
                "PYCHATTER_BACKEND_PORT": str(self.server_port),
            },
        )

    def restart_web_local(self) -> None:
        self.stop_web_local()
        self.root.after(700, self.start_web_local)

    def stop_web_local(self) -> None:
        self.web_local_process.stop(self.log_queue)

    def start_web_public(self) -> None:
        self._stop_conflicting_web(keep_public=True)
        self.web_http_port, self.web_ws_port = self._allocate_web_ports()
        self._append_log("control", f"Using public web ports http={self.web_http_port}, ws={self.web_ws_port}")
        self.web_public_process.start(
            self.log_queue,
            {
                "PYCHATTER_WEB_PORT": str(self.web_http_port),
                "PYCHATTER_WS_PORT": str(self.web_ws_port),
                "PYCHATTER_BACKEND_PORT": str(self.server_port),
            },
        )

    def restart_web_public(self) -> None:
        self.stop_web_public()
        self.root.after(700, self.start_web_public)

    def stop_web_public(self) -> None:
        self.web_public_process.stop(self.log_queue)

    def start_server_and_public(self) -> None:
        self.start_server()
        self.root.after(500, self.start_web_public)

    def stop_all(self) -> None:
        self.stop_web_local()
        self.stop_web_public()
        self.stop_server()

    def clear_log(self) -> None:
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")

    def refresh_token(self) -> None:
        token = self._read_token()
        if not token:
            messagebox.showinfo("DB Token", "No token file yet. Start the public web host first.")
            return
        self.token_var.set(token)
        self.db_url_var.set(self._build_db_url(self._current_host_for_db()))
        self._append_log("control", "Refreshed DB viewer token display")

    def on_close(self) -> None:
        if any([
            self.server_process.is_running(),
            self.web_local_process.is_running(),
            self.web_public_process.is_running(),
        ]):
            if not messagebox.askyesno(
                "Leave processes running?",
                "Close the control panel and leave started processes running in the background?",
            ):
                self.stop_all()
                self.root.after(800, self.root.destroy)
                return
        self.root.destroy()

    def _allocate_web_ports(self) -> tuple[int, int]:
        http_port = _pick_open_port(9010)
        ws_port = _pick_open_port(9011, {http_port})
        return http_port, ws_port


def main() -> None:
    root = tk.Tk()
    app = ServerControlGUI(root)
    if len(sys.argv) > 1 and sys.argv[1] == "--autostart-public":
        app.start_server_and_public()
    root.mainloop()


if __name__ == "__main__":
    main()