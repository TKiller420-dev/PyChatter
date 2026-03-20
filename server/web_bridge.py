import asyncio
import functools
import http.server
import os
import pathlib
import sys
import threading
from typing import Any

import websockets

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from shared.protocol import decode_packet, encode_packet


WEB_ROOT = pathlib.Path(__file__).resolve().parent.parent / "web"
HTTP_PORT = 9010
WS_PORT = 9011


def start_http_server() -> None:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(WEB_ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), handler)
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
        reader, writer = await asyncio.open_connection("127.0.0.1", 8765)
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
    start_http_server()
    print(f"Web UI: http://127.0.0.1:{HTTP_PORT}")
    print(f"WebSocket bridge: ws://127.0.0.1:{WS_PORT}/ws")
    async with websockets.serve(
        ws_handler,
        "127.0.0.1",
        WS_PORT,
        max_size=2**20,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
