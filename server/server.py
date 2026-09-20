import asyncio
import os
import re
import sys
import time
from collections import defaultdict
from typing import Any, Dict, Set

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from native.native_bridge import fast_hash
from shared.protocol import decode_packet, encode_packet
from store import ChatStore, normalize_role, normalize_roles, primary_role, role_rank


ROLE_LABELS = {
    "owner": "Owner",
    "god": "God",
    "admin": "Admin",
    "satan": "Satan",
    "lead_developer": "Lead Developer",
    "developer": "Developer",
    "mod": "Mod",
    "member": "Member",
}
FULL_CONTROL_ROLES = {"owner", "god"}
ROLE_MANAGER_ROLES = FULL_CONTROL_ROLES | {"admin", "lead_developer"}
MODERATION_ROLES = ROLE_MANAGER_ROLES | {"satan", "mod"}
MESSAGE_POWER_ROLES = MODERATION_ROLES | {"developer"}


class ChatServer:
    def __init__(self) -> None:
        db_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "chat.db"))
        self.store = ChatStore(db_path)
        self.clients: Dict[asyncio.StreamWriter, dict[str, Any]] = {}
        self.client_channels: Dict[asyncio.StreamWriter, str] = {}
        self.online_users: Dict[str, asyncio.StreamWriter] = {}
        self.channels: Dict[str, Set[asyncio.StreamWriter]] = defaultdict(set)
        for ch in self.store.list_channels():
            self.channels[ch] = set()
        self.voice_rooms: Dict[str, Set[asyncio.StreamWriter]] = defaultdict(set)
        self.voice_by_writer: Dict[asyncio.StreamWriter, str] = {}
        for room in self.store.list_voice_rooms():
            self.voice_rooms[room] = set()
            # Every in-memory connection is gone on a fresh start, so any
            # occupancy persisted from before a restart/crash is stale —
            # zero it out rather than let the admin dashboard show ghosts.
            self.store.set_voice_room_occupancy(room, 0)
        if "lobby" not in self.voice_rooms:
            self.store.ensure_voice_room("lobby", "system")
            self.voice_rooms["lobby"] = set()

        # New feature tracking
        self.user_statuses: Dict[str, str] = {}  # username -> status (online/away/dnd/offline)
        self.user_custom_status: Dict[str, str] = {}  # username -> custom message
        self.blocked_users: Dict[str, Set[str]] = defaultdict(set)  # username -> blocked_users
        self.pinned_messages: Dict[str, list] = defaultdict(list)  # channel -> [msg_ids]
        self.timeouts: Dict[str, float] = {}  # username -> unix ts when timeout expires
        self.polls: Dict[str, dict] = {}  # channel -> active poll {id, question, options, votes, created_by}

    def _roles_for(self, writer: asyncio.StreamWriter) -> list[str]:
        client = self.clients.get(writer, {})
        return normalize_roles(client.get("role", "member"))

    def _has_any_role(self, writer: asyncio.StreamWriter, allowed: set[str]) -> bool:
        return bool(set(self._roles_for(writer)) & allowed)

    def _can_assign_role(self, actor_roles: list[str], target_roles: list[str], role: str) -> bool:
        if set(actor_roles) & FULL_CONTROL_ROLES:
            return True
        if "owner" in target_roles or "god" in target_roles:
            return False
        if "admin" in actor_roles:
            return normalize_role(role) not in FULL_CONTROL_ROLES
        if "lead_developer" in actor_roles:
            return role_rank(role) <= role_rank("developer")
        return False

    def _poll_packet(self, channel: str) -> dict:
        poll = self.polls.get(channel)
        if not poll:
            return {"type": "poll_update", "channel": channel, "poll": None}
        return {
            "type": "poll_update",
            "channel": channel,
            "poll": {
                "id": poll["id"],
                "question": poll["question"],
                "options": poll["options"],
                "counts": [len(poll["votes"][i]) for i in range(len(poll["options"]))],
                "created_by": poll["created_by"],
            },
        }

    async def send(self, writer: asyncio.StreamWriter, packet: dict) -> None:
        writer.write(encode_packet(packet))
        await writer.drain()

    async def broadcast(self, channel: str, packet: dict) -> None:
        dead_writers: list[asyncio.StreamWriter] = []
        writers = list(self.channels[channel])
        for writer in writers:
            try:
                writer.write(encode_packet(packet))
            except (ConnectionError, OSError):
                dead_writers.append(writer)

        for writer in dead_writers:
            self.disconnect(writer)

        for writer in writers:
            await writer.drain()

    def _statuses_for(self, usernames: list[str]) -> Dict[str, str]:
        return {u: self.user_statuses.get(u, "online") for u in usernames}

    async def send_roster(self, channel: str) -> None:
        users = sorted(
            [
                self.clients[w]["username"]
                for w in self.channels[channel]
                if w in self.clients
            ]
        )
        profiles = self.store.get_user_profiles(users)
        await self.broadcast(
            channel,
            {
                "type": "user_list",
                "channel": channel,
                "users": users,
                "profiles": profiles,
                "statuses": self._statuses_for(users),
            },
        )

    async def send_social_state(self, writer: asyncio.StreamWriter) -> None:
        if writer not in self.clients:
            return
        username = self.clients[writer]["username"]
        voice_state = {
            room: sorted(
                [self.clients[w]["username"] for w in members if w in self.clients]
            )
            for room, members in self.voice_rooms.items()
        }
        dm_partners = self.store.list_dm_partners(username)
        profile_names = set([username])
        profile_names.update(self.store.list_friends(username))
        profile_names.update(self.store.list_incoming_friend_requests(username))
        profile_names.update(p["username"] for p in dm_partners)
        for members in voice_state.values():
            profile_names.update(members)
        profiles = self.store.get_user_profiles(sorted(profile_names))
        await self.send(
            writer,
            {
                "type": "social_state",
                "friends": self.store.list_friends(username),
                "incoming_requests": self.store.list_incoming_friend_requests(username),
                "voice_rooms": sorted(self.voice_rooms.keys()),
                "voice_state": voice_state,
                "voice_room": self.voice_by_writer.get(writer, ""),
                "profiles": profiles,
                "statuses": self._statuses_for(sorted(profile_names)),
                "my_status": self.user_statuses.get(username, "online"),
                "custom_statuses": {u: self.user_custom_status.get(u, "") for u in profile_names},
                "dm_partners": dm_partners,
            },
        )

    async def broadcast_social_state(self) -> None:
        for writer in list(self.clients.keys()):
            try:
                await self.send_social_state(writer)
            except Exception:
                pass

    def disconnect(self, writer: asyncio.StreamWriter) -> None:
        client = self.clients.pop(writer, None)
        username = client["username"] if client else None
        session_id = client.get("session_id") if client else None
        channel = self.client_channels.pop(writer, None)
        if username in self.online_users and self.online_users[username] is writer:
            self.online_users.pop(username, None)
        if channel and writer in self.channels[channel]:
            self.channels[channel].remove(writer)
        voice_room = self.voice_by_writer.pop(writer, None)
        if voice_room and writer in self.voice_rooms.get(voice_room, set()):
            self.voice_rooms[voice_room].discard(writer)
            self.store.set_voice_room_occupancy(voice_room, len(self.voice_rooms[voice_room]))

        if username:
            self.store.set_user_presence(username, is_online=False)
        if session_id is not None:
            self.store.close_session(int(session_id))

        try:
            writer.close()
        except Exception:
            pass

        if username and channel:
            asyncio.create_task(
                self.broadcast(
                    channel,
                    {
                        "type": "system",
                        "channel": channel,
                        "message": f"{username} left #{channel}",
                        "timestamp": int(time.time()),
                    },
                )
            )
            asyncio.create_task(self.send_roster(channel))
            asyncio.create_task(self.broadcast_social_state())
            self.store.log_event("user_disconnected", actor=username, channel=channel)

    async def send_channel_context(self, writer: asyncio.StreamWriter, channel: str, switched: bool) -> None:
        history = self.store.get_channel_history(channel, limit=50)
        packet_type = "channel_switched" if switched else "welcome"
        client = self.clients[writer]
        await self.send(
            writer,
            {
                "type": packet_type,
                "username": client["username"],
                "role": client["role"],
                "channels": sorted(self.channels.keys()),
                "channel": channel,
                "history": history,
                "pinned": self.store.get_pins(channel),
                "poll": self._poll_packet(channel)["poll"],
                "favorites": self.store.get_favorite_channels(client["username"]),
                "unread_counts": self.store.get_unread_counts(client["username"]),
                "bookmarks": self.store.get_bookmarks(client["username"]),
                "blocked_users": self.store.get_blocked(client["username"]),
                "mentions": self.store.get_mentions(client["username"]),
            },
        )

    async def handle_auth(self, writer: asyncio.StreamWriter, packet: dict) -> None:
        if writer in self.clients:
            return

        action = str(packet.get("action", "login")).strip().lower()
        remember = bool(packet.get("remember", False))

        if action == "token":
            token = str(packet.get("token", "")).strip()
            ok, username, role, error_message = self.store.authenticate_remember_token(token)
            if not ok:
                await self.send(writer, {"type": "auth_error", "message": error_message})
                return
        else:
            username = str(packet.get("username", "")).strip().lower()[:24]
            password = str(packet.get("password", ""))

            if not username or not password:
                await self.send(writer, {"type": "auth_error", "message": "Username and password are required."})
                return

            if action == "register":
                ok, message = self.store.register_user(username, password)
                if not ok:
                    await self.send(writer, {"type": "auth_error", "message": message})
                    return

            ok, role, error_message = self.store.authenticate_user(username, password)
            if not ok:
                await self.send(writer, {"type": "auth_error", "message": error_message})
                return

        old_writer = self.online_users.get(username)
        if old_writer and old_writer is not writer:
            await self.send(old_writer, {"type": "system", "message": "You were logged out because your account logged in elsewhere."})
            self.disconnect(old_writer)

        channel = "general"
        self.store.ensure_channel(channel)
        self.store.upsert_channel_membership(username, channel)
        session_id = self.store.create_session(username, str(writer.get_extra_info("peername")))
        self.channels[channel].add(writer)
        self.clients[writer] = {"username": username, "role": role, "session_id": session_id}
        self.client_channels[writer] = channel
        self.online_users[username] = writer
        saved_status, saved_custom_status = self.store.get_user_status(username)
        self.user_statuses[username] = saved_status
        self.user_custom_status[username] = saved_custom_status
        self.blocked_users[username] = set(self.store.get_blocked(username))
        self.store.log_event("user_authenticated", actor=username, channel=channel, metadata={"action": action})

        profile = self.store.get_user_profile(username)
        auth_ok_packet = {
            "type": "auth_ok",
            "username": username,
            "role": role,
            "avatar_url": profile.get("avatar_url", ""),
            "name_color": profile.get("name_color", ""),
        }
        if action == "token" or remember:
            auth_ok_packet["remember_token"] = self.store.create_remember_token(username)
        await self.send(writer, auth_ok_packet)
        await self.send_channel_context(writer, channel, switched=False)
        await self.send_social_state(writer)
        await self.broadcast(
            channel,
            {
                "type": "system",
                "channel": channel,
                "message": f"{username} joined #{channel}",
                "timestamp": int(time.time()),
            },
        )
        await self.send_roster(channel)
        await self.broadcast_social_state()

    async def handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        peer = writer.get_extra_info("peername")
        print(f"Connected: {peer}")

        try:
            while True:
                line = await reader.readline()
                if not line:
                    break

                packet = decode_packet(line)
                kind = packet.get("type")
                if writer in self.clients:
                    session_id = self.clients[writer].get("session_id")
                    if session_id is not None:
                        self.store.touch_session(int(session_id))

                if kind == "auth":
                    await self.handle_auth(writer, packet)

                elif kind == "logout":
                    token = str(packet.get("remember_token", "")).strip()
                    if token:
                        self.store.revoke_remember_token(token)
                    if writer in self.clients:
                        await self.send(writer, {"type": "logged_out"})
                    self.disconnect(writer)
                    break

                elif kind == "switch_channel":
                    if writer not in self.clients:
                        continue
                    new_channel = str(packet.get("channel", "general")).strip().lower()[:32]
                    if not new_channel:
                        new_channel = "general"
                    self.store.ensure_channel(new_channel)
                    self.channels.setdefault(new_channel, set())

                    old_channel = self.client_channels.get(writer, "general")
                    self.channels[old_channel].discard(writer)
                    self.channels[new_channel].add(writer)
                    self.client_channels[writer] = new_channel
                    username = self.clients[writer]["username"]
                    self.store.upsert_channel_membership(username, new_channel)
                    self.store.log_event(
                        "channel_switch",
                        actor=username,
                        channel=new_channel,
                        metadata={"from": old_channel, "to": new_channel},
                    )

                    await self.send_channel_context(writer, new_channel, switched=True)
                    await self.send_roster(old_channel)
                    await self.send_roster(new_channel)

                elif kind == "message":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    channel = self.client_channels.get(writer, "general")
                    content = str(packet.get("content", "")).strip()
                    if not content:
                        continue

                    timeout_until = self.timeouts.get(username, 0)
                    if timeout_until > time.time():
                        remaining = int(timeout_until - time.time())
                        await self.send(writer, {
                            "type": "action_error",
                            "message": f"You are timed out for {remaining}s and cannot send messages.",
                        })
                        continue

                    reply_to = None
                    reply_preview = None
                    raw_reply_to = packet.get("reply_to")
                    if raw_reply_to:
                        try:
                            reply_to = int(raw_reply_to)
                            reply_preview = self.store.get_reply_preview(reply_to)
                        except (TypeError, ValueError):
                            reply_to = None

                    msg_id = fast_hash(f"{username}:{time.time_ns()}:{content}")
                    created_at = int(time.time())
                    self.store.save_channel_message(msg_id, channel, username, content, reply_to)
                    profile = self.store.get_user_profile(username)
                    packet_out = {
                        "type": "message",
                        "id": msg_id,
                        "channel": channel,
                        "author": username,
                        "author_avatar_url": profile.get("avatar_url", ""),
                        "author_name_color": profile.get("name_color", ""),
                        "content": content,
                        "created_at": created_at,
                        "reply_preview": reply_preview,
                    }
                    self.store.log_event("channel_message", actor=username, channel=channel, metadata={"id": msg_id})
                    await self.broadcast(channel, packet_out)

                    # Lightweight activity ping (no content) so clients viewing a
                    # different channel can show a real unread indicator — they
                    # never receive the "message" packet itself since broadcast()
                    # only reaches sockets currently in that channel.
                    for other_writer, other_channel in list(self.client_channels.items()):
                        if other_channel != channel and other_writer in self.clients:
                            try:
                                await self.send(other_writer, {"type": "channel_activity", "channel": channel})
                            except Exception:
                                pass

                    mentioned = set(re.findall(r"@([a-z0-9_-]{1,24})", content.lower()))
                    mentioned.discard(username)
                    for target in mentioned:
                        self.store.record_mention(target, msg_id, channel, username, content)
                        target_writer = self.online_users.get(target)
                        if target_writer and target_writer in self.clients:
                            await self.send(target_writer, {
                                "type": "mention",
                                "id": msg_id,
                                "by": username,
                                "channel": channel,
                                "content": content,
                            })

                elif kind == "search_messages":
                    if writer not in self.clients:
                        continue
                    query = str(packet.get("query", "")).strip()
                    if not query:
                        continue
                    dm_with = str(packet.get("with", "")).strip().lower()[:24]
                    if dm_with:
                        requester = self.clients[writer]["username"]
                        results = self.store.search_dm_messages(requester, dm_with, query, limit=30)
                        await self.send(writer, {
                            "type": "search_results",
                            "scope": "dm",
                            "with": dm_with,
                            "query": query,
                            "results": results,
                        })
                        continue
                    channel = str(packet.get("channel", "")).strip().lower() or self.client_channels.get(writer, "general")
                    results = self.store.search_channel_messages(channel, query, limit=30)
                    await self.send(writer, {
                        "type": "search_results",
                        "channel": channel,
                        "query": query,
                        "results": results,
                    })

                elif kind == "poll_create":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    channel = self.client_channels.get(writer, "general")
                    question = str(packet.get("question", "")).strip()[:200]
                    options = [str(o).strip()[:80] for o in packet.get("options", []) if str(o).strip()][:6]
                    if not question or len(options) < 2:
                        await self.send(writer, {"type": "action_error", "message": "A poll needs a question and at least 2 options."})
                        continue
                    poll_id = fast_hash(f"poll:{username}:{time.time_ns()}:{question}")
                    self.polls[channel] = {
                        "id": poll_id,
                        "question": question,
                        "options": options,
                        "votes": {i: set() for i in range(len(options))},
                        "created_by": username,
                    }
                    self.store.log_event("poll_created", actor=username, channel=channel, metadata={"id": poll_id})
                    await self.broadcast(channel, self._poll_packet(channel))

                elif kind == "poll_vote":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    channel = self.client_channels.get(writer, "general")
                    poll = self.polls.get(channel)
                    try:
                        option_idx = int(packet.get("option", -1))
                    except (TypeError, ValueError):
                        continue
                    if not poll or poll["id"] != packet.get("poll_id") or option_idx not in poll["votes"]:
                        continue
                    for voters in poll["votes"].values():
                        voters.discard(username)
                    poll["votes"][option_idx].add(username)
                    await self.broadcast(channel, self._poll_packet(channel))

                elif kind == "moderate_kick":
                    if writer not in self.clients:
                        continue
                    actor_role = self.clients[writer]["role"]
                    if actor_role not in {"admin", "mod"}:
                        await self.send(writer, {"type": "action_error", "message": "Only mods and admins can kick users."})
                        continue
                    target = str(packet.get("username", "")).strip().lower()[:24]
                    target_writer = self.online_users.get(target)
                    if not target_writer or target_writer not in self.clients:
                        await self.send(writer, {"type": "action_error", "message": "User is not online."})
                        continue
                    actor = self.clients[writer]["username"]
                    channel = self.client_channels.get(target_writer, "general")
                    await self.send(target_writer, {"type": "system", "message": f"You were kicked by {actor}."})
                    self.store.log_event("user_kicked", actor=actor, target=target, channel=channel)
                    self.disconnect(target_writer)

                elif kind == "moderate_timeout":
                    if writer not in self.clients:
                        continue
                    actor_role = self.clients[writer]["role"]
                    if actor_role not in {"admin", "mod"}:
                        await self.send(writer, {"type": "action_error", "message": "Only mods and admins can time out users."})
                        continue
                    target = str(packet.get("username", "")).strip().lower()[:24]
                    try:
                        seconds = max(0, min(3600, int(packet.get("seconds", 60))))
                    except (TypeError, ValueError):
                        seconds = 60
                    if not target:
                        continue
                    actor = self.clients[writer]["username"]
                    self.timeouts[target] = time.time() + seconds
                    self.store.log_event("user_timeout", actor=actor, target=target, metadata={"seconds": seconds})
                    target_writer = self.online_users.get(target)
                    if target_writer and target_writer in self.clients:
                        await self.send(target_writer, {
                            "type": "system",
                            "message": f"You were timed out for {seconds}s by {actor}.",
                        })
                    await self.send(writer, {"type": "system", "message": f"{target} timed out for {seconds}s."})

                elif kind == "dm":
                    if writer not in self.clients:
                        continue
                    sender = self.clients[writer]["username"]
                    recipient = str(packet.get("to", "")).strip().lower()[:24]
                    content = str(packet.get("content", "")).strip()
                    if not recipient or not content:
                        continue
                    if recipient == sender:
                        await self.send(writer, {"type": "action_error", "message": "You cannot DM yourself."})
                        continue
                    if not self.store.user_exists(recipient):
                        await self.send(writer, {"type": "action_error", "message": f"User '{recipient}' does not exist."})
                        continue
                    if sender in self.store.get_blocked(recipient):
                        await self.send(writer, {"type": "action_error", "message": "You cannot message this user."})
                        continue

                    msg_id = fast_hash(f"dm:{sender}:{recipient}:{time.time_ns()}:{content}")
                    created_at = int(time.time())
                    self.store.save_dm(msg_id, sender, recipient, content)
                    profile = self.store.get_user_profile(sender)
                    dm_packet = {
                        "type": "dm",
                        "id": msg_id,
                        "sender": sender,
                        "recipient": recipient,
                        "content": content,
                        "created_at": created_at,
                        "author_avatar_url": profile.get("avatar_url", ""),
                        "author_name_color": profile.get("name_color", ""),
                    }
                    self.store.log_event(
                        "direct_message",
                        actor=sender,
                        target=recipient,
                        metadata={"id": msg_id},
                    )
                    await self.send(writer, dm_packet)
                    to_writer = self.online_users.get(recipient)
                    if to_writer and to_writer is not writer:
                        await self.send(to_writer, dm_packet)
                    await self.broadcast_social_state()

                elif kind == "dm_mark_read":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    partner = str(packet.get("with", "")).strip().lower()[:24]
                    if partner and self.store.user_exists(partner):
                        self.store.mark_dm_read(username, partner)
                        await self.send_social_state(writer)

                elif kind == "dm_history":
                    if writer not in self.clients:
                        continue
                    requester = self.clients[writer]["username"]
                    peer_user = str(packet.get("with", "")).strip().lower()[:24]
                    if not peer_user:
                        continue
                    history = self.store.get_dm_history(requester, peer_user, limit=50)
                    if history:
                        authors = {str(m.get("sender", "")).strip().lower() for m in history}
                        dm_profiles = self.store.get_user_profiles(sorted(authors))
                        for m in history:
                            p = dm_profiles.get(str(m.get("sender", "")).strip().lower(), {})
                            m["author_avatar_url"] = p.get("avatar_url", "")
                            m["author_name_color"] = p.get("name_color", "")
                    await self.send(
                        writer,
                        {
                            "type": "dm_history",
                            "with": peer_user,
                            "history": history,
                        },
                    )

                elif kind == "promote":
                    if writer not in self.clients:
                        continue
                    requester_role = self.clients[writer]["role"]
                    if requester_role != "admin":
                        await self.send(writer, {"type": "system", "message": "Only admins can change roles."})
                        continue

                    target = str(packet.get("username", "")).strip().lower()[:24]
                    new_role = str(packet.get("role", "member")).strip().lower()
                    if new_role not in {"member", "mod", "admin"}:
                        await self.send(writer, {"type": "system", "message": "Role must be member, mod, or admin."})
                        continue

                    if not self.store.set_user_role(target, new_role):
                        await self.send(writer, {"type": "system", "message": "User not found."})
                        continue

                    target_writer = self.online_users.get(target)
                    if target_writer and target_writer in self.clients:
                        self.clients[target_writer]["role"] = new_role
                        await self.send(target_writer, {"type": "role_update", "role": new_role})
                    self.store.log_event(
                        "role_changed",
                        actor=self.clients[writer]["username"],
                        target=target,
                        metadata={"role": new_role},
                    )
                    await self.send(writer, {"type": "system", "message": f"Updated {target} to role {new_role}."})

                elif kind == "who":
                    if writer not in self.clients:
                        continue
                    channel = self.client_channels.get(writer, "general")
                    users = sorted(
                        [
                            self.clients[w]["username"]
                            for w in self.channels[channel]
                            if w in self.clients
                        ]
                    )
                    profiles = self.store.get_user_profiles(users)
                    await self.send(
                        writer,
                        {"type": "user_list", "channel": channel, "users": users, "profiles": profiles},
                    )

                elif kind == "social_sync":
                    if writer not in self.clients:
                        continue
                    await self.send_social_state(writer)

                elif kind == "friend_request":
                    if writer not in self.clients:
                        continue
                    sender = self.clients[writer]["username"]
                    target = str(packet.get("to", "")).strip().lower()[:24]
                    ok, msg = self.store.send_friend_request(sender, target)
                    if not ok:
                        await self.send(writer, {"type": "action_error", "message": msg})
                        continue
                    self.store.log_event("friend_request_sent", actor=sender, target=target)
                    await self.broadcast_social_state()

                elif kind == "friend_accept":
                    if writer not in self.clients:
                        continue
                    accepter = self.clients[writer]["username"]
                    from_user = str(packet.get("from", "")).strip().lower()[:24]
                    ok, msg = self.store.accept_friend_request(accepter, from_user)
                    if not ok:
                        await self.send(writer, {"type": "action_error", "message": msg})
                        continue
                    self.store.log_event("friend_request_accepted", actor=accepter, target=from_user)
                    await self.broadcast_social_state()

                elif kind == "friend_remove":
                    if writer not in self.clients:
                        continue
                    actor = self.clients[writer]["username"]
                    target = str(packet.get("user", "")).strip().lower()[:24]
                    if not target:
                        continue
                    if not self.store.remove_friend(actor, target):
                        await self.send(writer, {"type": "action_error", "message": "You are not friends with that user."})
                        continue
                    self.store.log_event("friend_removed", actor=actor, target=target)
                    await self.broadcast_social_state()

                elif kind == "voice_room_create":
                    if writer not in self.clients:
                        continue
                    actor = self.clients[writer]["username"]
                    room = str(packet.get("room", "")).strip().lower()[:32]
                    if not room:
                        await self.send(writer, {"type": "action_error", "message": "Room name is required."})
                        continue
                    self.store.ensure_voice_room(room, actor)
                    self.voice_rooms.setdefault(room, set())
                    self.store.log_event("voice_room_created", actor=actor, metadata={"room": room})
                    await self.broadcast_social_state()

                elif kind == "voice_join":
                    if writer not in self.clients:
                        continue
                    actor = self.clients[writer]["username"]
                    room = str(packet.get("room", "")).strip().lower()[:32]
                    if not room:
                        await self.send(writer, {"type": "action_error", "message": "Room name is required."})
                        continue
                    self.store.ensure_voice_room(room, actor)
                    self.voice_rooms.setdefault(room, set())
                    prev = self.voice_by_writer.get(writer)
                    if prev and writer in self.voice_rooms.get(prev, set()):
                        self.voice_rooms[prev].discard(writer)
                        self.store.set_voice_room_occupancy(prev, len(self.voice_rooms[prev]))
                    self.voice_rooms[room].add(writer)
                    self.voice_by_writer[writer] = room
                    self.store.set_voice_room_occupancy(room, len(self.voice_rooms[room]))
                    self.store.log_event("voice_join", actor=actor, metadata={"room": room, "from": prev or ""})
                    await self.broadcast_social_state()

                elif kind == "voice_leave":
                    if writer not in self.clients:
                        continue
                    actor = self.clients[writer]["username"]
                    prev = self.voice_by_writer.pop(writer, None)
                    if prev and writer in self.voice_rooms.get(prev, set()):
                        self.voice_rooms[prev].discard(writer)
                        self.store.set_voice_room_occupancy(prev, len(self.voice_rooms[prev]))
                        self.store.log_event("voice_leave", actor=actor, metadata={"room": prev})
                        await self.broadcast_social_state()

                elif kind == "change_username":
                    if writer not in self.clients:
                        continue

                    old_username = self.clients[writer]["username"]
                    new_username = str(packet.get("new_username", "")).strip().lower()[:24]
                    if not new_username:
                        await self.send(writer, {"type": "action_error", "message": "New username is required."})
                        continue

                    existing_writer = self.online_users.get(new_username)
                    if existing_writer is not None and existing_writer is not writer:
                        await self.send(writer, {"type": "action_error", "message": "That username is already active."})
                        continue

                    ok, error_message = self.store.change_username(old_username, new_username)
                    if not ok:
                        await self.send(writer, {"type": "action_error", "message": error_message})
                        continue

                    self.clients[writer]["username"] = new_username
                    if old_username in self.online_users:
                        self.online_users.pop(old_username, None)
                    self.online_users[new_username] = writer
                    self.store.set_user_presence(old_username, is_online=False)
                    self.store.set_user_presence(new_username, is_online=True)

                    channel = self.client_channels.get(writer, "general")
                    self.store.log_event(
                        "username_changed_live",
                        actor=new_username,
                        target=old_username,
                        channel=channel,
                    )
                    await self.send(writer, {"type": "username_changed", "username": new_username})
                    await self.broadcast(
                        channel,
                        {
                            "type": "system",
                            "channel": channel,
                            "message": f"{old_username} is now known as {new_username}",
                            "timestamp": int(time.time()),
                        },
                    )
                    await self.send_roster(channel)
                    await self.broadcast_social_state()

                elif kind == "set_profile":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    avatar_url = str(packet.get("avatar_url", ""))
                    name_color = str(packet.get("name_color", ""))
                    ok, error_message = self.store.set_user_profile(username, avatar_url, name_color)
                    if not ok:
                        await self.send(writer, {"type": "action_error", "message": error_message})
                        continue
                    profile = self.store.get_user_profile(username)
                    await self.send(
                        writer,
                        {
                            "type": "profile_updated",
                            "username": username,
                            "avatar_url": profile.get("avatar_url", ""),
                            "name_color": profile.get("name_color", ""),
                        },
                    )
                    channel = self.client_channels.get(writer, "general")
                    self.store.log_event("profile_updated", actor=username, channel=channel)
                    await self.send_roster(channel)
                    await self.broadcast_social_state()

                elif kind == "edit_message":
                    if writer not in self.clients:
                        continue
                    client = self.clients[writer]
                    username = client["username"]
                    try:
                        msg_id = int(packet.get("id", 0))
                    except (TypeError, ValueError):
                        continue
                    new_content = str(packet.get("content", "")).strip()
                    if not new_content or not msg_id:
                        continue
                    ok, error = self.store.edit_message(msg_id, username, new_content)
                    if not ok:
                        await self.send(writer, {"type": "action_error", "message": error})
                        continue
                    channel = self.client_channels.get(writer, "general")
                    self.store.log_event("message_edited", actor=username, channel=channel, metadata={"id": msg_id})
                    await self.broadcast(channel, {
                        "type": "edited_message",
                        "id": msg_id,
                        "content": new_content,
                        "edited_at": int(time.time()),
                    })

                elif kind == "delete_message":
                    if writer not in self.clients:
                        continue
                    client = self.clients[writer]
                    username = client["username"]
                    role = client["role"]
                    try:
                        msg_id = int(packet.get("id", 0))
                    except (TypeError, ValueError):
                        continue
                    if not msg_id:
                        continue
                    ok, ch, error = self.store.delete_message(msg_id, username, role)
                    if not ok:
                        await self.send(writer, {"type": "action_error", "message": error})
                        continue
                    broadcast_channel = ch or self.client_channels.get(writer, "general")
                    self.store.log_event("message_deleted", actor=username, channel=broadcast_channel, metadata={"id": msg_id})
                    await self.broadcast(broadcast_channel, {
                        "type": "deleted_message",
                        "id": msg_id,
                    })

                elif kind == "react":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    try:
                        msg_id = int(packet.get("id", 0))
                    except (TypeError, ValueError):
                        continue
                    emoji = str(packet.get("emoji", "")).strip()
                    _ALLOWED_EMOJI = {"👍", "👎", "❤️", "😂", "😮", "😢", "🔥", "🎉"}
                    if not msg_id or emoji not in _ALLOWED_EMOJI:
                        continue
                    channel = self.client_channels.get(writer, "general")
                    reactions = self.store.toggle_reaction(msg_id, username, emoji)
                    await self.broadcast(channel, {
                        "type": "reaction_update",
                        "id": msg_id,
                        "reactions": reactions,
                    })

                elif kind == "set_status":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    status = str(packet.get("status", "online")).strip().lower()
                    if status == "away":  # accept legacy alias
                        status = "idle"
                    if status not in {"online", "idle", "dnd", "offline"}:
                        status = "online"
                    self.user_statuses[username] = status
                    self.clients[writer]["status"] = status
                    self.store.set_user_status(username, status)
                    channel = self.client_channels.get(writer, "general")
                    await self.send_roster(channel)
                    await self.broadcast_social_state()

                elif kind == "set_custom_status":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    message = str(packet.get("message", "")).strip()[:100]
                    self.user_custom_status[username] = message
                    self.store.set_user_status(username, self.user_statuses.get(username, "online"), message)
                    # Broadcast to everyone currently connected so their member
                    # lists update live, regardless of channel/friend relationship —
                    # cheap at this app's scale and simpler than tracking who
                    # "can see" this user.
                    update = {"type": "custom_status_update", "username": username, "message": message}
                    for other_writer in list(self.clients.keys()):
                        try:
                            await self.send(other_writer, update)
                        except Exception:
                            pass

                elif kind == "block_user":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    target = str(packet.get("user", "")).strip().lower()[:24]
                    if target and target != username:
                        self.blocked_users[username].add(target)
                        self.store.set_blocked(username, target, True)
                        await self.send(writer, {
                            "type": "system",
                            "message": f"Blocked {target}"
                        })

                elif kind == "unblock_user":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    target = str(packet.get("user", "")).strip().lower()[:24]
                    if target in self.blocked_users[username]:
                        self.blocked_users[username].remove(target)
                        self.store.set_blocked(username, target, False)
                        await self.send(writer, {
                            "type": "system",
                            "message": f"Unblocked {target}"
                        })

                elif kind == "pin_message":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    role = self.clients[writer]["role"]
                    if role not in {"admin", "mod"}:
                        await self.send(writer, {"type": "action_error", "message": "Only mods and admins can pin messages."})
                        continue
                    channel = self.client_channels.get(writer, "general")
                    self.pinned_messages[channel] = self.store.get_pins(channel)
                    try:
                        msg_id = int(packet.get("id", 0))
                    except (TypeError, ValueError):
                        continue
                    if msg_id and msg_id not in self.pinned_messages[channel]:
                        self.pinned_messages[channel].append(msg_id)
                        self.store.set_pin(channel, msg_id, username, True)
                        self.store.log_event("message_pinned", actor=username, channel=channel, metadata={"id": msg_id})
                        await self.broadcast(channel, {
                            "type": "pinned_update",
                            "channel": channel,
                            "pinned": self.pinned_messages[channel],
                        })

                elif kind == "unpin_message":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    role = self.clients[writer]["role"]
                    if role not in {"admin", "mod"}:
                        await self.send(writer, {"type": "action_error", "message": "Only mods and admins can unpin messages."})
                        continue
                    channel = self.client_channels.get(writer, "general")
                    self.pinned_messages[channel] = self.store.get_pins(channel)
                    try:
                        msg_id = int(packet.get("id", 0))
                    except (TypeError, ValueError):
                        continue
                    if msg_id in self.pinned_messages[channel]:
                        self.pinned_messages[channel].remove(msg_id)
                        self.store.set_pin(channel, msg_id, username, False)
                        self.store.log_event("message_unpinned", actor=username, channel=channel, metadata={"id": msg_id})
                        await self.broadcast(channel, {
                            "type": "pinned_update",
                            "channel": channel,
                            "pinned": self.pinned_messages[channel],
                        })

                elif kind == "channel_favorite":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    channel = str(packet.get("channel", "")).strip().lower()[:32]
                    favorite = bool(packet.get("favorite", False))
                    if channel not in self.channels:
                        await self.send(writer, {"type": "action_error", "message": "Channel not found."})
                        continue
                    self.store.set_channel_favorite(username, channel, favorite)
                    await self.send(writer, {
                        "type": "channel_state",
                        "favorites": self.store.get_favorite_channels(username),
                    })

                elif kind == "mark_read":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    channel = str(packet.get("channel", "")).strip().lower()[:32]
                    if channel:
                        self.store.mark_channel_read(username, channel)
                    await self.send(writer, {
                        "type": "unread_state",
                        "unread_counts": self.store.get_unread_counts(username),
                    })

                elif kind == "bookmark_message":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    try:
                        msg_id = int(packet.get("id", 0))
                    except (TypeError, ValueError):
                        continue
                    channel = str(packet.get("channel", "")).strip().lower()[:32]
                    bookmarked = bool(packet.get("bookmarked", True))
                    if not msg_id or not channel:
                        continue
                    self.store.set_bookmark(username, msg_id, channel, bookmarked)
                    await self.send(writer, {
                        "type": "bookmark_state",
                        "bookmarks": self.store.get_bookmarks(username),
                    })

                elif kind == "mention_history":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    await self.send(writer, {"type": "mention_history", "mentions": self.store.get_mentions(username)})

                elif kind == "user_state_sync":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    status, custom_status = self.store.get_user_status(username)
                    self.user_statuses[username] = status
                    self.user_custom_status[username] = custom_status
                    self.blocked_users[username] = set(self.store.get_blocked(username))
                    await self.send(writer, {
                        "type": "user_state",
                        "status": status,
                        "custom_status": custom_status,
                        "blocked_users": self.store.get_blocked(username),
                        "bookmarks": self.store.get_bookmarks(username),
                        "favorites": self.store.get_favorite_channels(username),
                        "unread_counts": self.store.get_unread_counts(username),
                        "mentions": self.store.get_mentions(username),
                    })

                elif kind == "typing":
                    if writer not in self.clients:
                        continue
                    username = self.clients[writer]["username"]
                    channel = self.client_channels.get(writer, "general")
                    for w in list(self.channels[channel]):
                        if w is not writer and w in self.clients:
                            try:
                                await self.send(w, {
                                    "type": "typing",
                                    "username": username,
                                    "channel": channel,
                                })
                            except Exception:
                                pass

                elif kind == "rtc_signal":
                    if writer not in self.clients:
                        continue
                    sender = self.clients[writer]["username"]
                    target = str(packet.get("to", "")).strip().lower()[:24]
                    signal_type = str(packet.get("signalType", "")).strip().lower()
                    if not target or signal_type not in {"offer", "answer", "ice", "hangup", "reject"}:
                        continue
                    target_writer = self.online_users.get(target)
                    if not target_writer or target_writer not in self.clients:
                        await self.send(writer, {"type": "action_error", "message": f"{target} is offline."})
                        continue

                    relay = {
                        "type": "rtc_signal",
                        "from": sender,
                        "signalType": signal_type,
                    }
                    if "sdp" in packet:
                        relay["sdp"] = packet["sdp"]
                    if "candidate" in packet:
                        relay["candidate"] = packet["candidate"]
                    if "mediaType" in packet:
                        relay["mediaType"] = packet["mediaType"]
                    await self.send(target_writer, relay)
                    self.store.log_event("rtc_signal", actor=sender, target=target, metadata={"signal_type": signal_type})

        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except Exception as exc:
            print(f"Client error from {peer}: {exc}")
        finally:
            self.disconnect(writer)
            print(f"Disconnected: {peer}")


async def main() -> None:
    host = os.getenv("PYCHATTER_HOST", "127.0.0.1")
    port = int(os.getenv("PYCHATTER_PORT", "8765"))
    server = ChatServer()

    try:
        # Default StreamReader limit is 64KB per line, which a base64 avatar
        # data-URL packet can exceed; raise it so those messages don't blow
        # up the read loop.
        srv = await asyncio.start_server(server.handle_client, host, port, limit=2 * 1024 * 1024)
    except OSError as exc:
        if exc.errno == 98:
            print(
                f"Cannot start PyChatter server on {host}:{port}: address already in use. "
                "Another instance is likely already running."
            )
            return
        raise
    print(f"PyChatter server listening on {host}:{port}")

    async with srv:
        await srv.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
