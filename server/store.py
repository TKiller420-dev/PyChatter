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

            # v2 migration: message editing, soft-delete, reactions.
            cur.execute("PRAGMA table_info(channel_messages)")
            cm_cols = {row[1] for row in cur.fetchall()}
            if "edited_at" not in cm_cols:
                cur.execute("ALTER TABLE channel_messages ADD COLUMN edited_at INTEGER")
            if "deleted" not in cm_cols:
                cur.execute("ALTER TABLE channel_messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")

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
                SELECT id, channel, author, content, created_at, edited_at, deleted
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
            reactions = self.get_reactions_bulk([r["id"] for r in rows])
            for row in rows:
                row["reactions"] = reactions.get(row["id"], {})
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
