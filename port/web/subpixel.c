#include "subpixel.h"
#include <emscripten.h>
#include <psyz/gte.h>
#include <stdint.h>
#include <string.h>

/* Each ordering table can outlive a browser frame in the adaptive renderer.
 * Keep its metadata until the same buffer is cleared for another build. */
/* Cover the expanded world buffers, including smaller packets packed into GT4 slots. */
enum { PACKET_TABLE_BITS = 16, PACKET_TABLE_SIZE = 1 << PACKET_TABLE_BITS };
typedef struct {
    const u_long* payload;
    int count;
    PsyzSubpixelPosition positions[4];
} PacketPositions;

typedef struct {
    unsigned int options;
    unsigned int count;
    PacketPositions packets[PACKET_TABLE_SIZE];
} BufferPositions;

static BufferPositions buffers[WEB_SUBPIXEL_BUFFER_COUNT];
static BufferPositions* active;
static unsigned int requested = PSYZ_STABILIZE_VERTICES | PSYZ_PERSPECTIVE_TEXTURES;

#ifdef TM4_WEB_TEST_HOOKS
static unsigned int submitted, fractional;
static PsyzSubpixelPosition first_position;
static int first_x, first_y;
#endif

static void set_option(unsigned int option, int enabled)
{
    if (enabled)
        requested |= option;
    else
        requested &= ~option;
}

EMSCRIPTEN_KEEPALIVE void WebSetSubpixelVertices(int enabled)
{
    set_option(PSYZ_STABILIZE_VERTICES, enabled);
}

EMSCRIPTEN_KEEPALIVE void WebSetPerspectiveTextures(int enabled)
{
    set_option(PSYZ_PERSPECTIVE_TEXTURES, enabled);
}

void WebSubpixelBegin(enum WebSubpixelBuffer buffer)
{
    BufferPositions* state = &buffers[buffer];
    if (state->count != 0) {
        memset(state->packets, 0, sizeof(state->packets));
        state->count = 0;
    }
    state->options = requested;
}

void WebSubpixelSelect(enum WebSubpixelBuffer buffer)
{
    BufferPositions* state = buffer == WEB_SUBPIXEL_NONE ? NULL : &buffers[buffer];
    active = state != NULL && state->options != 0 ? state : NULL;
}

void WebSubpixelDraw(enum WebSubpixelBuffer buffer, OT_TYPE* ordering)
{
#ifdef TM4_WEB_TEST_HOOKS
    submitted = fractional = 0;
#endif
    WebSubpixelSelect(buffer);
    DrawOTag(ordering);
    WebSubpixelSelect(WEB_SUBPIXEL_NONE);
    static unsigned int applied = UINT32_MAX;
    if (applied != buffers[buffer].options) {
        applied = buffers[buffer].options;
        EM_ASM(
            {
                tm4Port.subpixelVertices = !!$0;
                tm4Port.perspectiveTextures = !!$1;
            },
            applied & PSYZ_STABILIZE_VERTICES, applied & PSYZ_PERSPECTIVE_TEXTURES);
    }
#ifdef TM4_WEB_TEST_HOOKS
    EM_ASM(
        {
            tm4Port.subpixelFrame = ({
                buffer : $0,
                submitted : $1,
                fractional : $2,
                first : $1 ? [ $3, $4, $5, $6 ] : null
            });
        },
        buffer, submitted, fractional, first_x, first_y, first_position.x, first_position.y);
#endif
}

typedef struct {
    MATRIX transform;
    int x, y;
    unsigned int distance;
} Projection;

static void read_projection(Projection* projection)
{
    ReadRotMatrix(&projection->transform);
    ReadGeomOffset(&projection->x, &projection->y);
    projection->distance = (unsigned short)ReadGeomScreen();
}

static double camera_coordinate(const MATRIX* transform, const SVECTOR* vertex, int axis)
{
    const short* row = transform->m[axis];
    return (double)transform->t[axis]
        + ((double)row[0] * vertex->vx + (double)row[1] * vertex->vy + (double)row[2] * vertex->vz)
        / 4096.0;
}

static PsyzSubpixelPosition project(
    const Projection* projection, const SVECTOR* vertex, u_long packed, unsigned int options)
{
    int sx = (int16_t)packed;
    int sy = (int16_t)(packed >> 16);
    PsyzSubpixelPosition position = { sx, sy, 0.0f };
    double z = camera_coordinate(&projection->transform, vertex, 2);
    /* Keep the GPU coordinates for GTE near-plane division and saturation. */
    if (z < 1.0 || z >= 65536.0 || (unsigned int)z * 2 <= projection->distance)
        return position;

    double factor = projection->distance / z;
    double x = camera_coordinate(&projection->transform, vertex, 0);
    double y = camera_coordinate(&projection->transform, vertex, 1);
    double px = projection->x + x * factor;
    double py = projection->y + y * factor;
    int valid_x
        = sx > -1024 && sx < 1023 && x >= -32768.0 && x < 32768.0 && px >= -1024.0 && px <= 1023.0;
    int valid_y
        = sy > -1024 && sy < 1023 && y >= -32768.0 && y < 32768.0 && py >= -1024.0 && py <= 1023.0;
    if (valid_x)
        position.x = px;
    if (valid_y)
        position.y = py;
    /* A clamped projection no longer follows the camera's perspective. */
    if ((options & PSYZ_PERSPECTIVE_TEXTURES) && projection->distance != 0 && valid_x && valid_y)
        position.inv_depth = 1.0 / z;
    return position;
}

void WebSubpixelCaptureTriple(PsyzSubpixelPosition* positions, const SVECTOR* vertices, int count)
{
    if (active == NULL)
        return;
    Projection projection;
    read_projection(&projection);
    for (int i = 0; i < count; ++i)
        positions[i]
            = project(&projection, &vertices[i], Psyz_GteDataRead(12 + i), active->options);
}

void WebSubpixelCapturePoints(PsyzSubpixelPosition* positions, const SVECTOR* const* vertices,
    const u_long* const* packed_positions, int count)
{
    if (active == NULL)
        return;
    Projection projection;
    read_projection(&projection);
    for (int i = 0; i < count; ++i)
        positions[i] = project(&projection, vertices[i], *packed_positions[i], active->options);
}

/* Used after all four vertices have reached an ordinary GP0 polygon packet. */
void WebSubpixelPacketQuad(const void* packet, const SVECTOR* const corners[4])
{
    if (active == NULL)
        return;
    const u_long* payload = (const u_long*)((const char*)packet + sizeof(OT_TYPE));
    unsigned int code = payload[0] >> 24;
    int stride = 1 + !!(code & 4) + !!(code & 16);
    const u_long* screen[4];
    PsyzSubpixelPosition positions[4];
    for (int i = 0; i < 4; ++i)
        screen[i] = &payload[1 + i * stride];
    WebSubpixelCapturePoints(positions, corners, screen, 4);
    WebSubpixelPacket(packet, positions, NULL, 4);
}

/* PsyZ dispatches linked-list payloads in place on wasm32. The exact payload
 * address follows the polygon through OT sorting even when its XYs repeat. */
static unsigned int packet_slot(const u_long* payload)
{
    uint32_t word_address = (uintptr_t)payload / sizeof(u_long);
    return (word_address * UINT32_C(0x9e3779b9)) >> (32 - PACKET_TABLE_BITS);
}

void WebSubpixelPacket(const void* packet, const PsyzSubpixelPosition* positions,
    const unsigned char* indices, int count)
{
    /* Leave one empty slot so misses always terminate even at capacity. */
    if (active == NULL || active->count == PACKET_TABLE_SIZE - 1)
        return;
    const u_long* payload = (const u_long*)((const char*)packet + sizeof(OT_TYPE));
    unsigned int slot = packet_slot(payload);
    while (active->packets[slot].payload != NULL && active->packets[slot].payload != payload)
        slot = (slot + 1) % PACKET_TABLE_SIZE;
    PacketPositions* entry = &active->packets[slot];
    if (entry->payload == NULL)
        ++active->count;
    entry->payload = payload;
    entry->count = count;
    for (int i = 0; i < count; ++i)
        entry->positions[i] = positions[indices ? indices[i] : i];
}

const PsyzSubpixelPosition* WebSubpixelFindPacket(
    const u_long* payload, int count, unsigned int* options)
{
    if (active == NULL)
        return NULL;
    for (unsigned int slot = packet_slot(payload); active->packets[slot].payload != NULL;
         slot = (slot + 1) % PACKET_TABLE_SIZE) {
        const PacketPositions* entry = &active->packets[slot];
        if (entry->payload != payload)
            continue;
        if (entry->count != count)
            return NULL;
        *options = active->options;
        return entry->positions;
    }
    return NULL;
}

void WebSubpixelRecordSubmission(
    const u_long* packets, const PsyzSubpixelPosition* positions, int count)
{
#ifdef TM4_WEB_TEST_HOOKS
    if (submitted == 0) {
        u_long packed = packets[1];
        first_position = positions[0];
        first_x = (int16_t)packed;
        first_y = (int16_t)(packed >> 16);
    }
    submitted += count;
    for (int i = 0; i < count; ++i) {
        const PsyzSubpixelPosition* position = &positions[i];
        fractional += position->x != (int)position->x || position->y != (int)position->y;
    }
#else
    (void)packets;
    (void)positions;
    (void)count;
#endif
}
