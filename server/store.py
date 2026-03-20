import hashlib
import json
import os
import sqlite3
import threading
import time
from typing import Any


class ChatStore:
    def __init__(self, db_path: str) -> None:
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self._migrate()

    def _migrate(self) -> None:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_salt BLOB NOT NULL,
                    password_hash BLOB NOT NULL,
                    role TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_login_at INTEGER,
                    last_seen_at INTEGER,
                    is_online INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS channels (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS channel_messages (
                    id INTEGER PRIMARY KEY,
                    channel TEXT NOT NULL,
                    author TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS direct_messages (
                    id INTEGER PRIMARY KEY,
                    sender TEXT NOT NULL,
                    recipient TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS user_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    peer TEXT,
                    connected_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL,
                    disconnected_at INTEGER,
                    FOREIGN KEY(username) REFERENCES users(username)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS channel_memberships (
                    username TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    joined_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL,
                    PRIMARY KEY (username, channel)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS audit_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    actor TEXT,
                    target TEXT,
                    channel TEXT,
                    metadata_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )
                """
            )
            cur.execute(
                "INSERT OR IGNORE INTO channels (name, created_at) VALUES (?, ?)",
                ("general", int(time.time())),
            )

            # Backward-compatible migration for older databases created before presence columns existed.
            cur.execute("PRAGMA table_info(users)")
            user_cols = {row[1] for row in cur.fetchall()}
            if "last_login_at" not in user_cols:
                cur.execute("ALTER TABLE users ADD COLUMN last_login_at INTEGER")
            if "last_seen_at" not in user_cols:
                cur.execute("ALTER TABLE users ADD COLUMN last_seen_at INTEGER")
            if "is_online" not in user_cols:
                cur.execute("ALTER TABLE users ADD COLUMN is_online INTEGER NOT NULL DEFAULT 0")

            self.conn.commit()

    def _hash_password(self, password: str, salt: bytes | None = None) -> tuple[bytes, bytes]:
        if salt is None:
            salt = os.urandom(16)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
        return salt, digest

    def register_user(self, username: str, password: str) -> tuple[bool, str]:
        username = username.strip().lower()
        if not username or len(username) < 3:
            return False, "Username must be at least 3 characters."
        if len(password) < 6:
            return False, "Password must be at least 6 characters."

        with self.lock:
            cur = self.conn.cursor()
            cur.execute("SELECT COUNT(*) AS n FROM users")
            first_user = int(cur.fetchone()["n"]) == 0
            role = "admin" if first_user else "member"
            salt, digest = self._hash_password(password)
            try:
                cur.execute(
                    """
                    INSERT INTO users (username, password_salt, password_hash, role, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (username, salt, digest, role, int(time.time())),
                )
                self.conn.commit()
            except sqlite3.IntegrityError:
                return False, "Username already exists."
        self.log_event("user_registered", actor=username, metadata={"role": role})
        return True, role

    def authenticate_user(self, username: str, password: str) -> tuple[bool, str, str]:
        username = username.strip().lower()
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "SELECT username, password_salt, password_hash, role FROM users WHERE username = ?",
                (username,),
            )
            row = cur.fetchone()
            if row is None:
                return False, "", "Invalid username or password."

            salt = row["password_salt"]
            expected = row["password_hash"]
            _, got = self._hash_password(password, salt)
            if got != expected:
                return False, "", "Invalid username or password."

            now = int(time.time())
            cur.execute(
                "UPDATE users SET last_login_at = ?, last_seen_at = ?, is_online = 1 WHERE username = ?",
                (now, now, username),
            )
            self.conn.commit()

            return True, row["role"], ""

    def set_user_presence(self, username: str, is_online: bool) -> None:
        username = username.strip().lower()
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "UPDATE users SET is_online = ?, last_seen_at = ? WHERE username = ?",
                (1 if is_online else 0, int(time.time()), username),
            )
            self.conn.commit()

    def create_session(self, username: str, peer: str) -> int:
        username = username.strip().lower()
        now = int(time.time())
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                INSERT INTO user_sessions (username, peer, connected_at, last_seen_at)
                VALUES (?, ?, ?, ?)
                """,
                (username, peer, now, now),
            )
            session_id = int(cur.lastrowid or 0)
            self.conn.commit()
            return session_id

    def touch_session(self, session_id: int) -> None:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "UPDATE user_sessions SET last_seen_at = ? WHERE id = ?",
                (int(time.time()), session_id),
            )
            self.conn.commit()

    def close_session(self, session_id: int) -> None:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "UPDATE user_sessions SET disconnected_at = ?, last_seen_at = ? WHERE id = ?",
                (int(time.time()), int(time.time()), session_id),
            )
            self.conn.commit()

    def upsert_channel_membership(self, username: str, channel: str) -> None:
        username = username.strip().lower()
        channel = channel.strip().lower()
        now = int(time.time())
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                INSERT INTO channel_memberships (username, channel, joined_at, last_seen_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(username, channel)
                DO UPDATE SET last_seen_at = excluded.last_seen_at
                """,
                (username, channel, now, now),
            )
            self.conn.commit()

    def log_event(
        self,
        event_type: str,
        actor: str = "",
        target: str = "",
        channel: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> None:
        payload = metadata or {}
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                INSERT INTO audit_events (event_type, actor, target, channel, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    event_type,
                    actor,
                    target,
                    channel,
                    json.dumps(payload, separators=(",", ":")),
                    int(time.time()),
                ),
            )
            self.conn.commit()

    def get_user_role(self, username: str) -> str:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute("SELECT role FROM users WHERE username = ?", (username.strip().lower(),))
            row = cur.fetchone()
            return row["role"] if row else "member"

    def set_user_role(self, username: str, role: str) -> bool:
        if role not in {"member", "mod", "admin"}:
            return False
        with self.lock:
            cur = self.conn.cursor()
            cur.execute("UPDATE users SET role = ? WHERE username = ?", (role, username.strip().lower()))
            updated = cur.rowcount > 0
            self.conn.commit()
            return updated

    def change_username(self, old_username: str, new_username: str) -> tuple[bool, str]:
        old_username = old_username.strip().lower()
        new_username = new_username.strip().lower()
        if len(new_username) < 3:
            return False, "Username must be at least 3 characters."
        if len(new_username) > 24:
            return False, "Username must be at most 24 characters."
        if old_username == new_username:
            return False, "That is already your username."

        with self.lock:
            cur = self.conn.cursor()
            cur.execute("SELECT 1 FROM users WHERE username = ?", (new_username,))
            if cur.fetchone() is not None:
                return False, "That username is already taken."

            cur.execute("SELECT 1 FROM users WHERE username = ?", (old_username,))
            if cur.fetchone() is None:
                return False, "Current user record not found."

            try:
                cur.execute("BEGIN")
                cur.execute("UPDATE users SET username = ? WHERE username = ?", (new_username, old_username))
                cur.execute("UPDATE channel_messages SET author = ? WHERE author = ?", (new_username, old_username))
                cur.execute("UPDATE direct_messages SET sender = ? WHERE sender = ?", (new_username, old_username))
                cur.execute(
                    "UPDATE direct_messages SET recipient = ? WHERE recipient = ?",
                    (new_username, old_username),
                )
                cur.execute("UPDATE user_sessions SET username = ? WHERE username = ?", (new_username, old_username))
                cur.execute(
                    "UPDATE channel_memberships SET username = ? WHERE username = ?",
                    (new_username, old_username),
                )
                cur.execute("COMMIT")
            except sqlite3.DatabaseError:
                cur.execute("ROLLBACK")
                return False, "Failed to update username."

        self.log_event(
            "username_changed",
            actor=new_username,
            target=old_username,
            metadata={"old": old_username, "new": new_username},
        )
        return True, ""

    def ensure_channel(self, channel: str) -> None:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "INSERT OR IGNORE INTO channels (name, created_at) VALUES (?, ?)",
                (channel, int(time.time())),
            )
            self.conn.commit()

    def list_channels(self) -> list[str]:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute("SELECT name FROM channels ORDER BY name ASC")
            return [row["name"] for row in cur.fetchall()]

    def save_channel_message(self, msg_id: int, channel: str, author: str, content: str) -> None:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                INSERT OR REPLACE INTO channel_messages (id, channel, author, content, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (msg_id, channel, author, content, int(time.time())),
            )
            self.conn.commit()

    def get_channel_history(self, channel: str, limit: int = 50) -> list[dict[str, Any]]:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                SELECT id, channel, author, content, created_at
                FROM channel_messages
                WHERE channel = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (channel, limit),
            )
            rows = [dict(row) for row in cur.fetchall()]
        rows.reverse()
        return rows

    def save_dm(self, msg_id: int, sender: str, recipient: str, content: str) -> None:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                INSERT OR REPLACE INTO direct_messages (id, sender, recipient, content, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (msg_id, sender, recipient, content, int(time.time())),
            )
            self.conn.commit()

    def get_dm_history(self, user_a: str, user_b: str, limit: int = 50) -> list[dict[str, Any]]:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                SELECT id, sender, recipient, content, created_at
                FROM direct_messages
                WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (user_a, user_b, user_b, user_a, limit),
            )
            rows = [dict(row) for row in cur.fetchall()]
        rows.reverse()
        return rows
