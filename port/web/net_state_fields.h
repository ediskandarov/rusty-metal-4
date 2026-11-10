#ifndef TM4_WEB_NET_STATE_FIELDS_H
#define TM4_WEB_NET_STATE_FIELDS_H

#include "src/main/object/private.h"

#include <stdint.h>

s32 WebNetWorldPolygonCount(void);

typedef struct StateBytes {
    u8* data;
    u32 capacity;
    u32 length;
    int overflow;
} StateBytes;

typedef struct NetStateOutput {
    u32* checksum;
    StateBytes* bytes;
} NetStateOutput;

static inline void state_byte(NetStateOutput* hash, u8 value)
{
    *hash->checksum = (*hash->checksum ^ value) * 16777619u;
    StateBytes* bytes = hash->bytes;
    if (!bytes)
        return;
    if (bytes->length == bytes->capacity)
        bytes->overflow = 1;
    else
        bytes->data[bytes->length++] = value;
}

static inline void field(NetStateOutput* hash, u32 value)
{
    for (unsigned shift = 0; shift < 32; shift += 8)
        state_byte(hash, value >> shift);
}

static inline void key(NetStateOutput* hash, const char* text)
{
    if (text == NULL) {
        field(hash, 0);
        return;
    }
    field(hash, 1);
    do {
        state_byte(hash, *text);
    } while (*text++);
}

#define VALUE(value) field(hash, (u32)(value))
#define XYZ(vector)                                                                                \
    do {                                                                                           \
        VALUE((vector).vx);                                                                        \
        VALUE((vector).vy);                                                                        \
        VALUE((vector).vz);                                                                        \
    } while (0)

static inline void rotation(NetStateOutput* hash, const MATRIX* value)
{
    for (unsigned row = 0; row < 3; ++row)
        for (unsigned column = 0; column < 3; ++column)
            VALUE(value->m[row][column]);
}

static inline void matrix(NetStateOutput* hash, const MATRIX* value)
{
    rotation(hash, value);
    for (unsigned axis = 0; axis < 3; ++axis)
        VALUE(value->t[axis]);
}

static inline u32 handle(const void* payload)
{
    if (!payload)
        return 0;
    return ObjectValidObject((void*)payload) ? ObjectGetHeader(payload)->serial + 1u : UINT32_MAX;
}

const char* WebNetWriteCars(NetStateOutput* hash);
int WebNetWriteObject(NetStateOutput* hash, const Tm4ObjectHeader* object, int inspect_payload);

#endif
