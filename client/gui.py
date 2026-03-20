import os
import queue
import socket
import sys
import threading
import time
import tkinter as tk
from tkinter import messagebox, simpledialog

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from shared.protocol import decode_packet, encode_packet


class ClientNetwork:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self.sock: socket.socket | None = None
        self.running = False
        self.inbox: queue.Queue[dict] = queue.Queue()

    def connect(self, username: str, password: str, register: bool) -> None:
        self.sock = socket.create_connection((self.host, self.port), timeout=5)
        self.running = True
        self.send(
            {
                "type": "auth",
                "action": "register" if register else "login",
                "username": username,
                "password": password,
            }
        )
        threading.Thread(target=self._reader_loop, daemon=True).start()

    def _reader_loop(self) -> None:
        assert self.sock is not None
        fp = self.sock.makefile("rb")
        while self.running:
            line = fp.readline()
            if not line:
                self.inbox.put({"type": "system", "message": "Disconnected from server."})
                self.running = False
                break
            try:
                self.inbox.put(decode_packet(line))
            except Exception:
                self.inbox.put({"type": "system", "message": "Malformed packet received."})

    def send(self, packet: dict) -> None:
        if not self.sock:
            return
        self.sock.sendall(encode_packet(packet))

    def close(self) -> None:
        self.running = False
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass


class ChatGUI:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("PyChatter")
        self.root.geometry("980x640")

        self.network = ClientNetwork("127.0.0.1", 8765)
        self.username = ""
        self.role = "member"
        self.current_channel = "general"
        self.dm_target = ""

        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.after(100, self.poll_inbox)

    def _build_ui(self) -> None:
        self.root.configure(bg="#1f1f2a")

        container = tk.Frame(self.root, bg="#1f1f2a")
        container.pack(fill="both", expand=True)

        sidebar = tk.Frame(container, bg="#171722", width=220)
        sidebar.pack(side="left", fill="y")
        sidebar.pack_propagate(False)

        tk.Label(
            sidebar,
            text="PyChatter",
            font=("Segoe UI", 16, "bold"),
            fg="#ffffff",
            bg="#171722",
        ).pack(pady=(16, 10))

        self.channel_list = tk.Listbox(
            sidebar,
            bg="#222235",
            fg="#f2f2f2",
            selectbackground="#3f6df1",
            activestyle="none",
            borderwidth=0,
            highlightthickness=0,
        )
        self.channel_list.pack(fill="both", expand=True, padx=12, pady=10)
        self.channel_list.bind("<<ListboxSelect>>", self.on_channel_selected)

        tk.Label(
            sidebar,
            text="Online Users",
            font=("Segoe UI", 10, "bold"),
            fg="#d3d3e0",
            bg="#171722",
        ).pack(pady=(2, 4))

        self.user_list = tk.Listbox(
            sidebar,
            bg="#222235",
            fg="#f2f2f2",
            selectbackground="#3f6df1",
            activestyle="none",
            borderwidth=0,
            highlightthickness=0,
            height=8,
        )
        self.user_list.pack(fill="x", padx=12, pady=(0, 8))
        self.user_list.bind("<<ListboxSelect>>", self.on_user_selected)

        actions = tk.Frame(sidebar, bg="#171722")
        actions.pack(fill="x", padx=12, pady=(0, 8))

        tk.Button(
            actions,
            text="Refresh Users",
            command=self.refresh_online_users,
            bg="#2f3150",
            fg="#ffffff",
            activebackground="#3f4472",
            relief="flat",
            padx=10,
            pady=8,
        ).pack(fill="x", pady=(0, 6))

        tk.Button(
            actions,
            text="DM Selected",
            command=self.send_dm_to_selected,
            bg="#2f3150",
            fg="#ffffff",
            activebackground="#3f4472",
            relief="flat",
            padx=10,
            pady=8,
        ).pack(fill="x", pady=(0, 6))

        tk.Button(
            actions,
            text="DM History",
            command=self.load_dm_with_selected,
            bg="#2f3150",
            fg="#ffffff",
            activebackground="#3f4472",
            relief="flat",
            padx=10,
            pady=8,
        ).pack(fill="x", pady=(0, 6))

        tk.Button(
            actions,
            text="Promote Selected",
            command=self.promote_selected_user,
            bg="#2f3150",
            fg="#ffffff",
            activebackground="#3f4472",
            relief="flat",
            padx=10,
            pady=8,
        ).pack(fill="x")

        add_channel_btn = tk.Button(
            sidebar,
            text="+ New Channel",
            command=self.new_channel,
            bg="#2f3150",
            fg="#ffffff",
            activebackground="#3f4472",
            relief="flat",
            padx=10,
            pady=8,
        )
        add_channel_btn.pack(fill="x", padx=12, pady=(0, 12))

        main = tk.Frame(container, bg="#202033")
        main.pack(side="left", fill="both", expand=True)

        self.header = tk.Label(
            main,
            text="#general",
            font=("Segoe UI", 14, "bold"),
            fg="#f4f4f4",
            bg="#202033",
            anchor="w",
            padx=14,
            pady=12,
        )
        self.header.pack(fill="x")

        self.subheader = tk.Label(
            main,
            text="Role: member",
            font=("Segoe UI", 10),
            fg="#b9bad0",
            bg="#202033",
            anchor="w",
            padx=14,
            pady=0,
        )
        self.subheader.pack(fill="x", pady=(0, 8))

        self.chat_text = tk.Text(
            main,
            wrap="word",
            bg="#131320",
            fg="#e8e8f0",
            borderwidth=0,
            highlightthickness=0,
            font=("Consolas", 11),
            state="disabled",
        )
        self.chat_text.pack(fill="both", expand=True, padx=14, pady=(0, 8))

        composer = tk.Frame(main, bg="#202033")
        composer.pack(fill="x", padx=14, pady=(0, 14))

        self.message_entry = tk.Entry(
            composer,
            bg="#2b2b40",
            fg="#ffffff",
            insertbackground="#ffffff",
            relief="flat",
            font=("Segoe UI", 11),
        )
        self.message_entry.pack(side="left", fill="x", expand=True, ipady=10)
        self.message_entry.bind("<Return>", self.send_message)

        send_btn = tk.Button(
            composer,
            text="Send",
            command=self.send_message,
            bg="#3f6df1",
            fg="#ffffff",
            activebackground="#5a82f4",
            relief="flat",
            padx=18,
            pady=10,
        )
        send_btn.pack(side="left", padx=(8, 0))

        self.add_line("System", "Connect to start chatting.")
        self.add_line("System", "Use sidebar buttons for DM, DM history, roster refresh, and role actions.")

    def connect(self) -> None:
        username = simpledialog.askstring("Username", "Choose your username:", parent=self.root)
        if not username:
            username = f"guest-{int(time.time()) % 1000}"
        password = simpledialog.askstring("Password", "Enter password:", show="*", parent=self.root)
        if not password:
            messagebox.showerror("Missing password", "Password is required.")
            return
        register = messagebox.askyesno("Register", "Create new account? (No = login)")

        self.username = username
        try:
            self.network.connect(username, password, register)
            self.add_line("System", f"Authenticating as {username}...")
        except OSError as exc:
            messagebox.showerror("Connection failed", str(exc))

    def poll_inbox(self) -> None:
        while True:
            try:
                packet = self.network.inbox.get_nowait()
            except queue.Empty:
                break
            self.handle_packet(packet)
        self.root.after(100, self.poll_inbox)

    def handle_packet(self, packet: dict) -> None:
        kind = packet.get("type")
        if kind == "auth_ok":
            self.username = packet.get("username", self.username)
            self.role = packet.get("role", self.role)
            self.subheader.config(text=f"Role: {self.role}")
            self.add_line("System", f"Logged in as {self.username} ({self.role})")
        elif kind == "auth_error":
            messagebox.showerror("Authentication failed", packet.get("message", "Unknown error"))
            self.on_close()
        elif kind == "welcome":
            channels = packet.get("channels", ["general"])
            self.refresh_channels(channels)
            self.current_channel = packet.get("channel", "general")
            self.header.config(text=f"#{self.current_channel}")
            self.role = packet.get("role", self.role)
            self.subheader.config(text=f"Role: {self.role}")
            self.render_history(packet.get("history", []))
            self.add_line("System", f"Welcome, {packet.get('username', self.username)}")
        elif kind == "channel_switched":
            channels = packet.get("channels", ["general"])
            self.refresh_channels(channels)
            self.current_channel = packet.get("channel", "general")
            self.header.config(text=f"#{self.current_channel}")
            self.render_history(packet.get("history", []))
            self.add_line("System", f"Switched to #{self.current_channel}")
        elif kind == "message":
            self.add_line(packet.get("author", "?"), packet.get("content", ""), packet.get("id"))
        elif kind == "dm":
            sender = packet.get("sender", "?")
            recipient = packet.get("recipient", "?")
            direction = "from" if recipient == self.username else "to"
            peer = sender if direction == "from" else recipient
            self.add_line("DM", f"{direction} {peer}: {packet.get('content', '')}", packet.get("id"))
        elif kind == "dm_history":
            self.add_line("System", f"DM history with {packet.get('with', '?')}")
            for msg in packet.get("history", []):
                direction = "from" if msg.get("recipient") == self.username else "to"
                peer = msg.get("sender") if direction == "from" else msg.get("recipient")
                self.add_line("DM", f"{direction} {peer}: {msg.get('content', '')}", msg.get("id"))
        elif kind == "user_list":
            self.refresh_users(packet.get("users", []))
        elif kind == "role_update":
            self.role = packet.get("role", self.role)
            self.subheader.config(text=f"Role: {self.role}")
            self.add_line("System", f"Your role is now {self.role}")
        elif kind == "system":
            self.add_line("System", packet.get("message", ""))

    def render_history(self, history: list[dict]) -> None:
        self.chat_text.configure(state="normal")
        self.chat_text.delete("1.0", tk.END)
        self.chat_text.configure(state="disabled")
        for msg in history:
            self.add_line(msg.get("author", "?"), msg.get("content", ""), msg.get("id"))

    def refresh_channels(self, channels: list[str]) -> None:
        self.channel_list.delete(0, tk.END)
        for ch in channels:
            self.channel_list.insert(tk.END, ch)
            if ch == self.current_channel:
                idx = self.channel_list.size() - 1
                self.channel_list.select_set(idx)

    def refresh_users(self, users: list[str]) -> None:
        self.user_list.delete(0, tk.END)
        for user in users:
            self.user_list.insert(tk.END, user)

    def on_user_selected(self, _event: tk.Event) -> None:
        selected = self.user_list.curselection()
        if not selected:
            return
        self.dm_target = self.user_list.get(selected[0])
        self.add_line("System", f"Selected user: {self.dm_target}")

    def refresh_online_users(self) -> None:
        self.network.send({"type": "who"})

    def send_dm_to_selected(self) -> None:
        if not self.dm_target:
            self.add_line("System", "Select a user first.")
            return

        content = simpledialog.askstring(
            "Direct Message",
            f"Message to {self.dm_target}:",
            parent=self.root,
        )
        if not content:
            return
        content = content.strip()
        if not content:
            return

        self.network.send({"type": "dm", "to": self.dm_target.lower(), "content": content})

    def load_dm_with_selected(self) -> None:
        if not self.dm_target:
            self.add_line("System", "Select a user first.")
            return
        self.network.send({"type": "dm_history", "with": self.dm_target.lower()})

    def promote_selected_user(self) -> None:
        if self.role != "admin":
            self.add_line("System", "Only admins can promote users.")
            return
        if not self.dm_target:
            self.add_line("System", "Select a user first.")
            return

        role = simpledialog.askstring(
            "Set Role",
            "Enter role: member, mod, or admin",
            parent=self.root,
        )
        if not role:
            return
        role = role.strip().lower()
        if role not in {"member", "mod", "admin"}:
            self.add_line("System", "Role must be member, mod, or admin.")
            return

        self.network.send(
            {
                "type": "promote",
                "username": self.dm_target.lower(),
                "role": role,
            }
        )

    def on_channel_selected(self, _event: tk.Event) -> None:
        selected = self.channel_list.curselection()
        if not selected:
            return
        channel = self.channel_list.get(selected[0])
        self.network.send({"type": "switch_channel", "channel": channel})

    def new_channel(self) -> None:
        channel = simpledialog.askstring("Channel", "Enter new channel name:", parent=self.root)
        if not channel:
            return
        channel = channel.strip().lower().replace(" ", "-")
        if not channel:
            return
        self.network.send({"type": "switch_channel", "channel": channel})

    def send_message(self, _event=None) -> None:
        content = self.message_entry.get().strip()
        if not content:
            return
        self.network.send({"type": "message", "content": content})
        self.message_entry.delete(0, tk.END)

    def add_line(self, author: str, message: str, msg_id: int | None = None) -> None:
        label = f"[{author}]"
        if msg_id is not None:
            label = f"[{author}#{msg_id}]"

        self.chat_text.configure(state="normal")
        self.chat_text.insert(tk.END, f"{label} {message}\n")
        self.chat_text.configure(state="disabled")
        self.chat_text.see(tk.END)

    def on_close(self) -> None:
        self.network.close()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    app = ChatGUI(root)
    app.connect()
    root.mainloop()


if __name__ == "__main__":
    main()
