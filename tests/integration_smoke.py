import json
import os
import socket
import time


HOST = os.getenv("PYCHATTER_TEST_HOST", "127.0.0.1")
PORT = int(os.getenv("PYCHATTER_TEST_PORT", "8765"))


def send(sock: socket.socket, packet: dict) -> None:
    sock.sendall((json.dumps(packet, separators=(",", ":")) + "\n").encode("utf-8"))


def recv_until(fp, predicate, timeout: float = 7.0):
    deadline = time.time() + timeout
    seen = []
    while time.time() < deadline:
        line = fp.readline()
        if not line:
            break
        pkt = json.loads(line.decode("utf-8"))
        seen.append(pkt)
        if predicate(pkt):
            return pkt, seen
    return None, seen


def main() -> int:
    suffix = str(int(time.time() * 1000))[-6:]
    user_a = f"testa{suffix}"
    user_b = f"testb{suffix}"
    user_a_new = f"testx{suffix}"
    password = "pass1234"

    try:
        sock_a = socket.create_connection((HOST, PORT), timeout=3)
        sock_b = socket.create_connection((HOST, PORT), timeout=3)
    except OSError as exc:
        print(f"FAIL: Cannot connect to server at {HOST}:{PORT}: {exc}")
        return 1

    file_a = sock_a.makefile("rb")
    file_b = sock_b.makefile("rb")

    send(sock_a, {"type": "auth", "action": "register", "username": user_a, "password": password})
    send(sock_b, {"type": "auth", "action": "register", "username": user_b, "password": password})

    welcome_a, seen_a = recv_until(file_a, lambda p: p.get("type") == "welcome")
    welcome_b, seen_b = recv_until(file_b, lambda p: p.get("type") == "welcome")
    if welcome_a is None or welcome_b is None:
        print("FAIL: auth/welcome did not complete")
        print(f"Seen A: {seen_a}")
        print(f"Seen B: {seen_b}")
        return 1

    channel_text = f"hello-channel-{suffix}"
    send(sock_a, {"type": "message", "content": channel_text})

    msg_pkt, seen_b_msg = recv_until(
        file_b,
        lambda p: p.get("type") == "message"
        and p.get("author") == user_a
        and p.get("content") == channel_text,
    )
    if msg_pkt is None:
        print("FAIL: channel message did not arrive at second client")
        print(f"Seen B: {seen_b_msg}")
        return 1

    dm_text = f"hello-dm-{suffix}"
    send(sock_a, {"type": "dm", "to": user_b, "content": dm_text})

    dm_pkt, seen_b_dm = recv_until(
        file_b,
        lambda p: p.get("type") == "dm"
        and p.get("sender") == user_a
        and p.get("recipient") == user_b
        and p.get("content") == dm_text,
    )
    if dm_pkt is None:
        print("FAIL: DM did not arrive at second client")
        print(f"Seen B: {seen_b_dm}")
        return 1

    sock_a.close()

    try:
        sock_login = socket.create_connection((HOST, PORT), timeout=3)
    except OSError as exc:
        print(f"FAIL: Cannot reconnect for login test: {exc}")
        return 1

    file_login = sock_login.makefile("rb")
    send(sock_login, {"type": "auth", "action": "login", "username": user_a, "password": password})
    login_ok, seen_login = recv_until(file_login, lambda p: p.get("type") == "welcome")
    if login_ok is None:
        print("FAIL: sign-in did not complete")
        print(f"Seen login: {seen_login}")
        return 1

    send(sock_login, {"type": "change_username", "new_username": user_a_new})
    rename_ok, seen_rename = recv_until(file_login, lambda p: p.get("type") == "username_changed")
    if rename_ok is None or rename_ok.get("username") != user_a_new:
        print("FAIL: username change did not complete")
        print(f"Seen rename: {seen_rename}")
        return 1

    rename_msg = f"hello-rename-{suffix}"
    send(sock_login, {"type": "message", "content": rename_msg})
    renamed_msg_pkt, seen_b_renamed = recv_until(
        file_b,
        lambda p: p.get("type") == "message"
        and p.get("author") == user_a_new
        and p.get("content") == rename_msg,
    )
    if renamed_msg_pkt is None:
        print("FAIL: renamed user could not send with new identity")
        print(f"Seen B: {seen_b_renamed}")
        return 1

    print("PASS: Integration smoke test succeeded")
    print(f"Users: {user_a} -> {user_a_new}, {user_b}")
    print(f"Channel message id: {msg_pkt.get('id')}")
    print(f"DM message id: {dm_pkt.get('id')}")
    print(f"Renamed message id: {renamed_msg_pkt.get('id')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
