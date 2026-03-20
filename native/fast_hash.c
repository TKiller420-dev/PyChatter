#include <stdint.h>
#include <stddef.h>

#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT
#endif

// 32-bit FNV-1a hash, useful for fast message IDs and lightweight sharding keys.
EXPORT uint32_t fast_fnv1a(const char* input) {
    uint32_t hash = 2166136261u;
    if (input == NULL) {
        return hash;
    }

    const unsigned char* data = (const unsigned char*)input;
    while (*data) {
        hash ^= (uint32_t)(*data++);
        hash *= 16777619u;
    }
    return hash;
}
