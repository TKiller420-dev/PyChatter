import asyncio
import os
import sys
import time
from collections import defaultdict
from typing import Any, Dict, Set

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from native.native_bridge import fast_hash
from shared.protocol import decode_packet, encode_packet
from store import ChatStore


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

    async def send_roster(self, channel: str) -> None:
        users = sorted(
            [
                self.clients[w]["username"]
                for w in self.channels[channel]
                if w in self.clients
            ]
        )
        await self.broadcast(
            channel,
            {
                "type": "user_list",
                "channel": channel,
                "users": users,
            },
        )

    def disconnect(self, writer: asyncio.StreamWriter) -> None:
        client = self.clients.pop(writer, None)
        username = client["username"] if client else None
        session_id = client.get("session_id") if client else None
        channel = self.client_channels.pop(writer, None)
        if username in self.online_users and self.online_users[username] is writer:
            self.online_users.pop(username, None)
        if channel and writer in self.channels[channel]:
            self.channels[channel].remove(writer)

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
        self.store.log_event("user_authenticated", actor=username, channel=channel, metadata={"action": action})

        auth_ok_packet = {"type": "auth_ok", "username": username, "role": role}
        if action == "token" or remember:
            auth_ok_packet["remember_token"] = self.store.create_remember_token(username)
        await self.send(writer, auth_ok_packet)
        await self.send_channel_context(writer, channel, switched=False)
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

                    msg_id = fast_hash(f"{username}:{time.time_ns()}:{content}")
                    created_at = int(time.time())
                    self.store.save_channel_message(msg_id, channel, username, content)
                    packet_out = {
                        "type": "message",
                        "id": msg_id,
                        "channel": channel,
                        "author": username,
                        "content": content,
                        "created_at": created_at,
                    }
                    self.store.log_event("channel_message", actor=username, channel=channel, metadata={"id": msg_id})
                    await self.broadcast(channel, packet_out)

                elif kind == "dm":
                    if writer not in self.clients:
                        continue
                    sender = self.clients[writer]["username"]
                    recipient = str(packet.get("to", "")).strip().lower()[:24]
                    content = str(packet.get("content", "")).strip()
                    if not recipient or not content:
                        continue

                    msg_id = fast_hash(f"dm:{sender}:{recipient}:{time.time_ns()}:{content}")
                    created_at = int(time.time())
                    self.store.save_dm(msg_id, sender, recipient, content)
                    dm_packet = {
                        "type": "dm",
                        "id": msg_id,
                        "sender": sender,
                        "recipient": recipient,
                        "content": content,
                        "created_at": created_at,
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

                elif kind == "dm_history":
                    if writer not in self.clients:
                        continue
                    requester = self.clients[writer]["username"]
                    peer_user = str(packet.get("with", "")).strip().lower()[:24]
                    if not peer_user:
                        continue
                    history = self.store.get_dm_history(requester, peer_user, limit=50)
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
                    await self.send(writer, {"type": "user_list", "channel": channel, "users": users})

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
                    if not target or signal_type not in {"offer", "answer", "ice", "hangup"}:
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
        srv = await asyncio.start_server(server.handle_client, host, port)
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
