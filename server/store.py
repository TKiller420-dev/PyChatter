import hashlib
import json
import os
import secrets
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
                    avatar_url TEXT,
                    name_color TEXT,
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
                CREATE TABLE IF NOT EXISTS dm_reads (
                    username TEXT NOT NULL,
                    partner TEXT NOT NULL,
                    last_read_at INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (username, partner)
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
                """
                CREATE TABLE IF NOT EXISTS remember_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    last_used_at INTEGER,
                    revoked_at INTEGER,
                    FOREIGN KEY(username) REFERENCES users(username)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS friend_edges (
                    user_low TEXT NOT NULL,
                    user_high TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (user_low, user_high)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS friend_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_user TEXT NOT NULL,
                    to_user TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    responded_at INTEGER
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS voice_rooms (
                    name TEXT PRIMARY KEY,
                    created_by TEXT NOT NULL,
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
            if "avatar_url" not in user_cols:
                cur.execute("ALTER TABLE users ADD COLUMN avatar_url TEXT")
            if "name_color" not in user_cols:
                cur.execute("ALTER TABLE users ADD COLUMN name_color TEXT")
            if "status" not in user_cols:
                cur.execute("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'online'")
            if "custom_status" not in user_cols:
                cur.execute("ALTER TABLE users ADD COLUMN custom_status TEXT NOT NULL DEFAULT ''")

            # v2 migration: message editing, soft-delete, reactions.
            cur.execute("PRAGMA table_info(channel_messages)")
            cm_cols = {row[1] for row in cur.fetchall()}
            if "edited_at" not in cm_cols:
                cur.execute("ALTER TABLE channel_messages ADD COLUMN edited_at INTEGER")
            if "deleted" not in cm_cols:
                cur.execute("ALTER TABLE channel_messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
            if "reply_to" not in cm_cols:
                cur.execute("ALTER TABLE channel_messages ADD COLUMN reply_to INTEGER")

            # v3 migration: live voice-room occupancy, written by the chat
            # server process and read by the (separate-process) admin
            # dashboard — the DB is the only channel between them.
            cur.execute("PRAGMA table_info(voice_rooms)")
            vr_cols = {row[1] for row in cur.fetchall()}
            if "active_users" not in vr_cols:
                cur.execute("ALTER TABLE voice_rooms ADD COLUMN active_users INTEGER NOT NULL DEFAULT 0")
            if "last_activity_at" not in vr_cols:
                cur.execute("ALTER TABLE voice_rooms ADD COLUMN last_activity_at INTEGER")

            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS message_reactions (
                    msg_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    emoji TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (msg_id, username, emoji)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS user_channel_state (
                    username TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    favorite INTEGER NOT NULL DEFAULT 0,
                    last_read_at INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (username, channel)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS message_bookmarks (
                    username TEXT NOT NULL,
                    msg_id INTEGER NOT NULL,
                    channel TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (username, msg_id)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS blocked_users (
                    username TEXT NOT NULL,
                    blocked_username TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (username, blocked_username)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS message_pins (
                    channel TEXT NOT NULL,
                    msg_id INTEGER NOT NULL,
                    pinned_by TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (channel, msg_id)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS mention_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    message_id INTEGER NOT NULL,
                    channel TEXT NOT NULL,
                    mentioned_by TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    seen INTEGER NOT NULL DEFAULT 0
                )
                """
            )

            self.conn.commit()

    def _hash_password(self, password: str, salt: bytes | None = None) -> tuple[bytes, bytes]:
        if salt is None:
            salt = os.urandom(16)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
        return salt, digest

    def _hash_token(self, token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def _friend_pair(self, user_a: str, user_b: str) -> tuple[str, str]:
        a = user_a.strip().lower()
        b = user_b.strip().lower()
        return (a, b) if a < b else (b, a)

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

    def create_remember_token(self, username: str, ttl_days: int = 30) -> str:
        username = username.strip().lower()
        now = int(time.time())
        token = secrets.token_urlsafe(32)
        token_hash = self._hash_token(token)
        expires_at = now + max(1, ttl_days) * 24 * 60 * 60
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                INSERT INTO remember_tokens (username, token_hash, created_at, expires_at, last_used_at, revoked_at)
                VALUES (?, ?, ?, ?, ?, NULL)
                """,
                (username, token_hash, now, expires_at, now),
            )
            self.conn.commit()
        return token

    def authenticate_remember_token(self, token: str) -> tuple[bool, str, str, str]:
        token = token.strip()
        if not token:
            return False, "", "", "Missing remember token."
        token_hash = self._hash_token(token)
        now = int(time.time())
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                SELECT rt.id AS token_id, rt.username AS username, u.role AS role, rt.expires_at AS expires_at
                FROM remember_tokens rt
                JOIN users u ON u.username = rt.username
                WHERE rt.token_hash = ? AND rt.revoked_at IS NULL
                """,
                (token_hash,),
            )
            row = cur.fetchone()
            if row is None:
                return False, "", "", "Session expired. Please sign in again."
            if int(row["expires_at"]) < now:
                cur.execute(
                    "UPDATE remember_tokens SET revoked_at = ? WHERE id = ?",
                    (now, int(row["token_id"])),
                )
                self.conn.commit()
                return False, "", "", "Session expired. Please sign in again."

            username = str(row["username"])
            role = str(row["role"])
            cur.execute(
                "UPDATE remember_tokens SET last_used_at = ? WHERE id = ?",
                (now, int(row["token_id"])),
            )
            cur.execute(
                "UPDATE users SET last_login_at = ?, last_seen_at = ?, is_online = 1 WHERE username = ?",
                (now, now, username),
            )
            self.conn.commit()
            return True, username, role, ""

    def revoke_remember_token(self, token: str) -> None:
        token = token.strip()
        if not token:
            return
        token_hash = self._hash_token(token)
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "UPDATE remember_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
                (int(time.time()), token_hash),
            )
            self.conn.commit()

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

    def get_user_profile(self, username: str) -> dict[str, str]:
        username = username.strip().lower()
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "SELECT avatar_url, name_color, role FROM users WHERE username = ?",
                (username,),
            )
            row = cur.fetchone()
            if row is None:
                return {"avatar_url": "", "name_color": "", "role": "member"}
            return {
                "avatar_url": str(row["avatar_url"] or ""),
                "name_color": str(row["name_color"] or ""),
                "role": str(row["role"] or "member"),
            }

    def get_user_profiles(self, usernames: list[str]) -> dict[str, dict[str, str]]:
        cleaned = sorted({u.strip().lower() for u in usernames if u and u.strip()})
        if not cleaned:
            return {}
        placeholders = ",".join("?" for _ in cleaned)
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                f"SELECT username, avatar_url, name_color, role FROM users WHERE username IN ({placeholders})",
                cleaned,
            )
            rows = cur.fetchall()
        out: dict[str, dict[str, str]] = {}
        for row in rows:
            uname = str(row["username"])
            out[uname] = {
                "avatar_url": str(row["avatar_url"] or ""),
                "name_color": str(row["name_color"] or ""),
                "role": str(row["role"] or "member"),
            }
        return out

    def set_user_profile(self, username: str, avatar_url: str, name_color: str) -> tuple[bool, str]:
        username = username.strip().lower()
        avatar_url = avatar_url.strip()
        name_color = name_color.strip().lower()

        is_data_image = avatar_url.startswith("data:image/")
        max_len = 300_000 if is_data_image else 500
        if avatar_url and len(avatar_url) > max_len:
            return False, "Profile picture is too large."
        if avatar_url and not (
            avatar_url.startswith("https://")
            or avatar_url.startswith("http://")
            or is_data_image
        ):
            return False, "Profile picture must be a valid URL (http/https) or data image."

        if name_color:
            if not (len(name_color) == 7 and name_color.startswith("#")):
                return False, "Name color must be a hex value like #5865f2."
            try:
                int(name_color[1:], 16)
            except ValueError:
                return False, "Name color must be a valid hex value like #5865f2."

        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "UPDATE users SET avatar_url = ?, name_color = ? WHERE username = ?",
                (avatar_url or None, name_color or None, username),
            )
            updated = cur.rowcount > 0
            self.conn.commit()
        if not updated:
            return False, "User not found."
        return True, ""

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
                cur.execute(
                    "UPDATE remember_tokens SET username = ? WHERE username = ?",
                    (new_username, old_username),
                )
                cur.execute("DELETE FROM friend_edges WHERE user_low = ? OR user_high = ?", (old_username, old_username))
                cur.execute("UPDATE friend_requests SET from_user = ? WHERE from_user = ?", (new_username, old_username))
                cur.execute("UPDATE friend_requests SET to_user = ? WHERE to_user = ?", (new_username, old_username))
                cur.execute("UPDATE voice_rooms SET created_by = ? WHERE created_by = ?", (new_username, old_username))
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

    def set_channel_favorite(self, username: str, channel: str, favorite: bool) -> None:
        with self.lock:
            self.conn.execute(
                "INSERT INTO user_channel_state(username, channel, favorite) VALUES (?, ?, ?) "
                "ON CONFLICT(username, channel) DO UPDATE SET favorite=excluded.favorite",
                (username, channel, 1 if favorite else 0),
            )
            self.conn.commit()

    def get_favorite_channels(self, username: str) -> list[str]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT channel FROM user_channel_state WHERE username = ? AND favorite = 1 ORDER BY channel",
                (username,),
            ).fetchall()
        return [str(row["channel"]) for row in rows]

    def mark_channel_read(self, username: str, channel: str) -> None:
        now = int(time.time())
        with self.lock:
            self.conn.execute(
                "INSERT INTO user_channel_state(username, channel, last_read_at) VALUES (?, ?, ?) "
                "ON CONFLICT(username, channel) DO UPDATE SET last_read_at=excluded.last_read_at",
                (username, channel, now),
            )
            self.conn.commit()

    def get_unread_counts(self, username: str) -> dict[str, int]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT c.name, COUNT(cm.id) AS unread FROM channels c "
                "LEFT JOIN user_channel_state s ON s.channel = c.name AND s.username = ? "
                "LEFT JOIN channel_messages cm ON cm.channel = c.name AND cm.deleted = 0 "
                "AND cm.created_at > COALESCE(s.last_read_at, 0) AND cm.author != ? "
                "GROUP BY c.name",
                (username, username),
            ).fetchall()
        return {str(row["name"]): int(row["unread"] or 0) for row in rows}

    def set_bookmark(self, username: str, msg_id: int, channel: str, bookmarked: bool) -> None:
        with self.lock:
            if bookmarked:
                self.conn.execute(
                    "INSERT OR IGNORE INTO message_bookmarks(username, msg_id, channel, created_at) VALUES (?, ?, ?, ?)",
                    (username, msg_id, channel, int(time.time())),
                )
            else:
                self.conn.execute("DELETE FROM message_bookmarks WHERE username = ? AND msg_id = ?", (username, msg_id))
            self.conn.commit()

    def get_bookmarks(self, username: str) -> list[dict[str, Any]]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT msg_id, channel, created_at FROM message_bookmarks WHERE username = ? ORDER BY created_at DESC LIMIT 200",
                (username,),
            ).fetchall()
        return [dict(row) for row in rows]

    def set_blocked(self, username: str, target: str, blocked: bool) -> None:
        with self.lock:
            if blocked:
                self.conn.execute(
                    "INSERT OR IGNORE INTO blocked_users(username, blocked_username, created_at) VALUES (?, ?, ?)",
                    (username, target, int(time.time())),
                )
            else:
                self.conn.execute(
                    "DELETE FROM blocked_users WHERE username = ? AND blocked_username = ?",
                    (username, target),
                )
            self.conn.commit()

    def get_blocked(self, username: str) -> list[str]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT blocked_username FROM blocked_users WHERE username = ? ORDER BY blocked_username",
                (username,),
            ).fetchall()
        return [str(row["blocked_username"]) for row in rows]

    def set_pin(self, channel: str, msg_id: int, username: str, pinned: bool) -> None:
        with self.lock:
            if pinned:
                self.conn.execute(
                    "INSERT OR IGNORE INTO message_pins(channel, msg_id, pinned_by, created_at) VALUES (?, ?, ?, ?)",
                    (channel, msg_id, username, int(time.time())),
                )
            else:
                self.conn.execute("DELETE FROM message_pins WHERE channel = ? AND msg_id = ?", (channel, msg_id))
            self.conn.commit()

    def get_pins(self, channel: str) -> list[int]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT msg_id FROM message_pins WHERE channel = ? ORDER BY created_at ASC",
                (channel,),
            ).fetchall()
        return [int(row["msg_id"]) for row in rows]

    def record_mention(self, username: str, message_id: int, channel: str, mentioned_by: str, content: str) -> None:
        with self.lock:
            self.conn.execute(
                "INSERT INTO mention_events(username, message_id, channel, mentioned_by, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (username, message_id, channel, mentioned_by, content, int(time.time())),
            )
            self.conn.commit()

    def get_mentions(self, username: str, limit: int = 50) -> list[dict[str, Any]]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT message_id, channel, mentioned_by, content, created_at, seen FROM mention_events "
                "WHERE username = ? ORDER BY created_at DESC LIMIT ?",
                (username, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def set_user_status(self, username: str, status: str, custom_status: str | None = None) -> None:
        with self.lock:
            if custom_status is None:
                self.conn.execute("UPDATE users SET status = ? WHERE username = ?", (status, username))
            else:
                self.conn.execute(
                    "UPDATE users SET status = ?, custom_status = ? WHERE username = ?",
                    (status, custom_status, username),
                )
            self.conn.commit()

    def get_user_status(self, username: str) -> tuple[str, str]:
        with self.lock:
            row = self.conn.execute("SELECT status, custom_status FROM users WHERE username = ?", (username,)).fetchone()
        return (str(row["status"] or "online"), str(row["custom_status"] or "")) if row else ("online", "")

    def list_channels(self) -> list[str]:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute("SELECT name FROM channels ORDER BY name ASC")
            return [row["name"] for row in cur.fetchall()]

    def save_channel_message(
        self, msg_id: int, channel: str, author: str, content: str, reply_to: int | None = None
    ) -> None:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                INSERT OR REPLACE INTO channel_messages (id, channel, author, content, created_at, reply_to)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (msg_id, channel, author, content, int(time.time()), reply_to),
            )
            self.conn.commit()

    def get_reply_preview(self, msg_id: int) -> dict[str, Any] | None:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "SELECT id, author, content, deleted FROM channel_messages WHERE id = ?",
                (msg_id,),
            )
            row = cur.fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "author": row["author"],
            "content": "[deleted]" if row["deleted"] else row["content"],
        }

    def get_channel_history(self, channel: str, limit: int = 50) -> list[dict[str, Any]]:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                SELECT id, channel, author, content, created_at, edited_at, deleted, reply_to
                FROM channel_messages
                WHERE channel = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (channel, limit),
            )
            rows = [dict(row) for row in cur.fetchall()]
        rows.reverse()
        if rows:
            authors = [str(r.get("author", "")).strip().lower() for r in rows]
            profiles = self.get_user_profiles(authors)
            for row in rows:
                profile = profiles.get(str(row.get("author", "")).strip().lower(), {})
                row["author_avatar_url"] = profile.get("avatar_url", "")
                row["author_name_color"] = profile.get("name_color", "")
        if rows:
            reactions = self.get_reactions_bulk([r["id"] for r in rows])
            for row in rows:
                row["reactions"] = reactions.get(row["id"], {})
        for row in rows:
            row["reply_preview"] = self.get_reply_preview(row["reply_to"]) if row.get("reply_to") else None
        return rows

    def search_channel_messages(self, channel: str, query: str, limit: int = 30) -> list[dict[str, Any]]:
        query = query.strip()
        if not query:
            return []
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                SELECT id, channel, author, content, created_at
                FROM channel_messages
                WHERE channel = ? AND deleted = 0 AND content LIKE ? ESCAPE '\\'
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (channel, "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%", limit),
            )
            rows = [dict(row) for row in cur.fetchall()]
        rows.reverse()
        return rows

    def edit_message(self, msg_id: int, author: str, new_content: str) -> tuple[bool, str]:
        """Edit a message — only the original author may do so."""
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "SELECT author, deleted FROM channel_messages WHERE id = ?",
                (msg_id,),
            )
            row = cur.fetchone()
            if row is None:
                return False, "Message not found."
            if row["deleted"]:
                return False, "Cannot edit a deleted message."
            if row["author"] != author:
                return False, "You can only edit your own messages."
            cur.execute(
                "UPDATE channel_messages SET content = ?, edited_at = ? WHERE id = ?",
                (new_content, int(time.time()), msg_id),
            )
            self.conn.commit()
        return True, ""

    def delete_message(
        self, msg_id: int, requester: str, requester_role: str
    ) -> tuple[bool, str, str]:
        """Soft-delete a message. Returns (ok, channel, error)."""
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "SELECT author, channel, deleted FROM channel_messages WHERE id = ?",
                (msg_id,),
            )
            row = cur.fetchone()
            if row is None:
                return False, "", "Message not found."
            if row["deleted"]:
                return False, "", "Message already deleted."
            if row["author"] != requester and requester_role not in ("mod", "admin"):
                return False, "", "You can only delete your own messages."
            cur.execute(
                "UPDATE channel_messages SET deleted = 1, content = '[deleted]' WHERE id = ?",
                (msg_id,),
            )
            self.conn.commit()
            ch = row["channel"]
        return True, ch, ""

    def toggle_reaction(
        self, msg_id: int, username: str, emoji: str
    ) -> dict[str, list[str]]:
        """Toggle a reaction; returns updated {emoji: [users]} for this message."""
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "SELECT 1 FROM message_reactions WHERE msg_id = ? AND username = ? AND emoji = ?",
                (msg_id, username, emoji),
            )
            if cur.fetchone() is not None:
                cur.execute(
                    "DELETE FROM message_reactions WHERE msg_id = ? AND username = ? AND emoji = ?",
                    (msg_id, username, emoji),
                )
            else:
                cur.execute(
                    "INSERT INTO message_reactions (msg_id, username, emoji, created_at) VALUES (?, ?, ?, ?)",
                    (msg_id, username, emoji, int(time.time())),
                )
            self.conn.commit()
            cur.execute(
                "SELECT emoji, username FROM message_reactions WHERE msg_id = ?",
                (msg_id,),
            )
            result: dict[str, list[str]] = {}
            for r in cur.fetchall():
                result.setdefault(r["emoji"], []).append(r["username"])
        return result

    def get_reactions_bulk(
        self, msg_ids: list[int]
    ) -> dict[int, dict[str, list[str]]]:
        """Return {msg_id: {emoji: [users]}} for all given message IDs."""
        if not msg_ids:
            return {}
        with self.lock:
            cur = self.conn.cursor()
            placeholders = ",".join("?" for _ in msg_ids)
            cur.execute(
                f"SELECT msg_id, emoji, username FROM message_reactions WHERE msg_id IN ({placeholders})",
                msg_ids,
            )
            result: dict[int, dict[str, list[str]]] = {}
            for row in cur.fetchall():
                mid = int(row["msg_id"])
                result.setdefault(mid, {}).setdefault(row["emoji"], []).append(row["username"])
        return result

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

    def search_dm_messages(self, user_a: str, user_b: str, query: str, limit: int = 30) -> list[dict[str, Any]]:
        query = query.strip()
        if not query:
            return []
        pattern = "%" + query.replace("%", "\\%").replace("_", "\\_") + "%"
        with self.lock:
            rows = self.conn.execute(
                "SELECT id, sender, recipient, content, created_at FROM direct_messages "
                "WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) "
                "AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?",
                (user_a, user_b, user_b, user_a, pattern, limit),
            ).fetchall()
        result = [dict(row) for row in rows]
        result.reverse()
        return result

    def list_dm_partners(self, username: str, limit: int = 30) -> list[dict[str, Any]]:
        username = username.strip().lower()
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                SELECT
                    CASE WHEN sender = ? THEN recipient ELSE sender END AS partner,
                    MAX(created_at) AS last_at
                FROM direct_messages
                WHERE (sender = ? OR recipient = ?) AND sender != recipient
                GROUP BY partner
                ORDER BY last_at DESC
                LIMIT ?
                """,
                (username, username, username, limit),
            )
            partners = [{"username": row["partner"], "lastAt": row["last_at"]} for row in cur.fetchall()]
            for partner in partners:
                read_row = cur.execute(
                    "SELECT last_read_at FROM dm_reads WHERE username = ? AND partner = ?",
                    (username, partner["username"]),
                ).fetchone()
                last_read = int(read_row["last_read_at"] if read_row else 0)
                unread_row = cur.execute(
                    "SELECT COUNT(*) AS n FROM direct_messages WHERE sender = ? AND recipient = ? AND created_at > ?",
                    (partner["username"], username, last_read),
                ).fetchone()
                partner["unread"] = int(unread_row["n"] or 0)
            return partners

    def mark_dm_read(self, username: str, partner: str) -> None:
        with self.lock:
            self.conn.execute(
                "INSERT INTO dm_reads(username, partner, last_read_at) VALUES (?, ?, ?) "
                "ON CONFLICT(username, partner) DO UPDATE SET last_read_at=excluded.last_read_at",
                (username, partner, int(time.time())),
            )
            self.conn.commit()

    def user_exists(self, username: str) -> bool:
        username = username.strip().lower()
        with self.lock:
            cur = self.conn.cursor()
            cur.execute("SELECT 1 FROM users WHERE username = ?", (username,))
            return cur.fetchone() is not None

    def list_friends(self, username: str) -> list[str]:
        username = username.strip().lower()
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                SELECT CASE WHEN user_low = ? THEN user_high ELSE user_low END AS friend
                FROM friend_edges
                WHERE user_low = ? OR user_high = ?
                ORDER BY friend ASC
                """,
                (username, username, username),
            )
            return [str(row["friend"]) for row in cur.fetchall()]

    def list_incoming_friend_requests(self, username: str) -> list[str]:
        username = username.strip().lower()
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                SELECT from_user
                FROM friend_requests
                WHERE to_user = ? AND status = 'pending'
                ORDER BY created_at ASC
                """,
                (username,),
            )
            return [str(row["from_user"]) for row in cur.fetchall()]

    def send_friend_request(self, from_user: str, to_user: str) -> tuple[bool, str]:
        from_user = from_user.strip().lower()
        to_user = to_user.strip().lower()
        if not to_user:
            return False, "Target username is required."
        if from_user == to_user:
            return False, "You cannot add yourself."
        if not self.user_exists(to_user):
            return False, "User not found."

        low, high = self._friend_pair(from_user, to_user)
        now = int(time.time())
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "SELECT 1 FROM friend_edges WHERE user_low = ? AND user_high = ?",
                (low, high),
            )
            if cur.fetchone() is not None:
                return False, "You are already friends."

            cur.execute(
                """
                SELECT id, from_user, to_user
                FROM friend_requests
                WHERE status = 'pending'
                  AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))
                ORDER BY id DESC LIMIT 1
                """,
                (from_user, to_user, to_user, from_user),
            )
            existing = cur.fetchone()
            if existing is not None:
                if str(existing["from_user"]) == to_user and str(existing["to_user"]) == from_user:
                    return False, "That user already sent you a request."
                return False, "Friend request already pending."

            cur.execute(
                "INSERT INTO friend_requests (from_user, to_user, status, created_at) VALUES (?, ?, 'pending', ?)",
                (from_user, to_user, now),
            )
            self.conn.commit()
        return True, "Friend request sent."

    def accept_friend_request(self, to_user: str, from_user: str) -> tuple[bool, str]:
        to_user = to_user.strip().lower()
        from_user = from_user.strip().lower()
        if to_user == from_user:
            return False, "Invalid friend request."

        low, high = self._friend_pair(to_user, from_user)
        now = int(time.time())
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                """
                SELECT id FROM friend_requests
                WHERE from_user = ? AND to_user = ? AND status = 'pending'
                ORDER BY id DESC LIMIT 1
                """,
                (from_user, to_user),
            )
            row = cur.fetchone()
            if row is None:
                return False, "No pending request from that user."

            cur.execute(
                "UPDATE friend_requests SET status = 'accepted', responded_at = ? WHERE id = ?",
                (now, int(row["id"])),
            )
            cur.execute(
                "INSERT OR IGNORE INTO friend_edges (user_low, user_high, created_at) VALUES (?, ?, ?)",
                (low, high, now),
            )
            self.conn.commit()
        return True, "Friend request accepted."

    def remove_friend(self, user_a: str, user_b: str) -> bool:
        user_a = user_a.strip().lower()
        user_b = user_b.strip().lower()
        if user_a == user_b:
            return False
        low, high = self._friend_pair(user_a, user_b)
        with self.lock:
            cur = self.conn.cursor()
            cur.execute("DELETE FROM friend_edges WHERE user_low = ? AND user_high = ?", (low, high))
            deleted = cur.rowcount > 0
            cur.execute(
                """
                UPDATE friend_requests SET status = 'declined', responded_at = ?
                WHERE status = 'pending' AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))
                """,
                (int(time.time()), user_a, user_b, user_b, user_a),
            )
            self.conn.commit()
            return deleted

    def ensure_voice_room(self, name: str, created_by: str) -> None:
        room = name.strip().lower()[:32]
        if not room:
            return
        creator = created_by.strip().lower()
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "INSERT OR IGNORE INTO voice_rooms (name, created_by, created_at) VALUES (?, ?, ?)",
                (room, creator or "system", int(time.time())),
            )
            self.conn.commit()

    def list_voice_rooms(self) -> list[str]:
        with self.lock:
            cur = self.conn.cursor()
            cur.execute("SELECT name FROM voice_rooms ORDER BY name ASC")
            return [str(row["name"]) for row in cur.fetchall()]

    def set_voice_room_occupancy(self, name: str, active_users: int) -> None:
        """Called by the chat server (server.py) whenever someone joins or
        leaves a voice room, so the separate admin_server.py process can
        report real live occupancy instead of a hardcoded value."""
        room = name.strip().lower()[:32]
        if not room:
            return
        with self.lock:
            cur = self.conn.cursor()
            cur.execute(
                "UPDATE voice_rooms SET active_users = ?, last_activity_at = ? WHERE name = ?",
                (max(0, active_users), int(time.time()), room),
            )
            self.conn.commit()
