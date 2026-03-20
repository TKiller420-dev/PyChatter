import json
from typing import Any, Dict


def encode_packet(packet: Dict[str, Any]) -> bytes:
    """Encode JSON packet with newline framing for socket streaming."""
    return (json.dumps(packet, separators=(",", ":")) + "\n").encode("utf-8")


def decode_packet(line: bytes) -> Dict[str, Any]:
    """Decode one newline-framed JSON packet."""
    return json.loads(line.decode("utf-8"))
