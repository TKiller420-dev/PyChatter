import ctypes
import os
import zlib


def _load_library() -> ctypes.CDLL | None:
    here = os.path.dirname(__file__)
    candidates = [
        os.path.join(here, "fast_hash.dll"),
        os.path.join(here, "libfast_hash.so"),
        os.path.join(here, "libfast_hash.dylib"),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            lib = ctypes.CDLL(candidate)
            lib.fast_fnv1a.argtypes = [ctypes.c_char_p]
            lib.fast_fnv1a.restype = ctypes.c_uint32
            return lib
    return None


_LIB = _load_library()


def fast_hash(text: str) -> int:
    """Use native C hashing when available; fall back to CRC32 for portability."""
    if _LIB is not None:
        return int(_LIB.fast_fnv1a(text.encode("utf-8")))
    return int(zlib.crc32(text.encode("utf-8")) & 0xFFFFFFFF)
