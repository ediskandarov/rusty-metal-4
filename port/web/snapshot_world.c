#include "snapshot_world.h"
#include "src/main/object/private.h"
#include "tm4/main/registry.h"
#include "tm4/modules/car_ai.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#ifdef TM4_WEB_TEST_HOOKS
#include <emscripten.h>
#endif

enum {
    WorldVersion = 1,
    MaxWorldFields = 128 * 1024,
    MaxWorldDelta = 8192,
    WorldHeaderWords = 4,
    WorldRecordWords = 2,
};

typedef enum {
    WorldByte,
    WorldShort,
    WorldOwner,
} WorldFieldKind;

typedef struct {
    void* address;
    u32 initial;
    WorldFieldKind kind;
} WorldField;

static struct {
    WorldField* fields;
    u32 count;
    u32 layout;
} world;

s32 WebNetWorldPolygonCount(void);

static void* polygon_base(const void* payload) { return WorldCollisionPolygons; }

static u32 polygon_count(const void* payload)
{
    const s32 count = WebNetWorldPolygonCount();
    return count > 0 ? count : 0;
}

const SnapshotIndexBinding WebSnapshotCollisionPolygons = {
    polygon_base,
    polygon_count,
    sizeof(Tm4CollisionPolygon),
};

static u32 read_field(const WorldField* field)
{
    if (field->kind == WorldByte)
        return *(const u8*)field->address;
    if (field->kind == WorldShort) {
        u16 value;
        memcpy(&value, field->address, sizeof(value));
        return value;
    }
    return WebSnapshotLiveHandle(*(void* const*)field->address);
}

static int remember(void* address, WorldFieldKind kind)
{
    if (world.count == MaxWorldFields)
        return 0;
    WorldField* field = &world.fields[world.count++];
    *field = (WorldField) { .address = address, .kind = kind };
    field->initial = read_field(field);
    world.layout = (world.layout ^ kind) * 16777619u;
    world.layout = (world.layout ^ field->initial) * 16777619u;
    return field->initial != UINT32_MAX;
}

static int remember_vector(SVECTOR* vector)
{
    return remember(&vector->vx, WorldShort) && remember(&vector->vy, WorldShort)
        && remember(&vector->vz, WorldShort);
}

static int remember_faces(s32 count)
{
    u8* next = WorldDisplayFaces;
    for (s32 i = 0; i < count; ++i) {
        Tm4DisplayFace* face = (Tm4DisplayFace*)next;
        switch (face->header.color0.components.cd & TM4_FACE_TYPE_MASK) {
        case TM4_FACE_FT3:
        case TM4_FACE_FT4:
            if (!remember(&face->flat.enabled, WorldByte))
                return 0;
            next += sizeof(face->flat);
            break;
        case TM4_FACE_GT3:
        case TM4_FACE_GT4:
            if (!remember(&face->gouraud.color3.components.cd, WorldByte))
                return 0;
            next += sizeof(face->gouraud);
            break;
        default:
            return 0;
        }
    }
    return 1;
}

static int remember_world(void)
{
    const s32* vertices = RegGetFileDataS("/world/displayPolys/numWorldVertices");
    const s32* faces = RegGetFileDataS("/world/displayPolys/numWorldFaces");
    const s32 polygons = WebNetWorldPolygonCount();
    if (!vertices || !faces || !WorldDisplayVertices || !WorldDisplayFaces
        || !WorldCollisionPolygons || *vertices <= 0 || *faces <= 0 || polygons <= 0
        || *vertices > MaxWorldFields / 3 || *faces > MaxWorldFields
        || polygons > MaxWorldFields / 26
        || aiWorldInfo.resource.area_count > ArrayCount(aiWorldInfo.areas)
        || (aiWorldInfo.resource.node_count && !aiWorldInfo.resource.nodes))
        return 0;
    if (!remember_faces(*faces))
        return 0;
    for (s32 i = 0; i < *vertices; ++i)
        if (!remember_vector(&WorldDisplayVertices[i]))
            return 0;
    for (s32 i = 0; i < polygons; ++i) {
        Tm4CollisionPolygon* polygon = &WorldCollisionPolygons[i];
        s32 corners = CollisionPolygonVertexCount(polygon);
        if (corners < 3 || corners > 4 || !remember(&polygon->owner, WorldOwner)
            || !remember(&CollisionPolygonEnabled(polygon), WorldShort))
            return 0;
        for (s32 corner = 0; corner < corners; ++corner)
            if (!remember_vector(&polygon->vertices[corner])
                || !remember_vector(&polygon->edge_directions[corner]))
                return 0;
    }
    for (s32 area_index = 0; area_index < aiWorldInfo.resource.area_count; ++area_index) {
        CarAiArea* area = &aiWorldInfo.areas[area_index];
        if (area->edge_count && !area->edges)
            return 0;
        for (s32 edge = 0; edge < area->edge_count; ++edge)
            if (!remember(&area->edges[edge].enabled, WorldByte))
                return 0;
    }
    for (s32 i = 0; i < aiWorldInfo.resource.node_count; ++i)
        if (!remember(&aiWorldInfo.resource.nodes[i].enabled, WorldByte))
            return 0;
    return 1;
}

int WebSnapshotWorldOpen(void)
{
    if (world.fields)
        return 0;
    world.fields = malloc(MaxWorldFields * sizeof(*world.fields));
    if (!world.fields)
        return 0;
    world.layout = 2166136261u;
#ifdef TM4_WEB_TEST_HOOKS
    EM_ASM({ tm4Port.testPortableWorldAddress = $0; }, WorldCollisionPolygons);
#endif
    if (!remember_world()) {
        WebSnapshotWorldClose();
        return 0;
    }
    return 1;
}

void WebSnapshotWorldClose(void)
{
    free(world.fields);
    memset(&world, 0, sizeof(world));
}

static void write_word(u8* output, u32 value)
{
    for (unsigned byte = 0; byte < 4; ++byte)
        output[byte] = value >> (8 * byte);
}

static u32 read_word(const u8* input)
{
    u32 value = 0;
    for (unsigned byte = 0; byte < 4; ++byte)
        value |= (u32)input[byte] << (8 * byte);
    return value;
}

u32 WebSnapshotWorldCapture(u8* output, u32 capacity)
{
    if (!world.fields || (output && capacity < 4 * WorldHeaderWords))
        return 0;
    u32 count = 0;
    for (u32 i = 0; i < world.count; ++i) {
        u32 value = read_field(&world.fields[i]);
        if (value == world.fields[i].initial)
            continue;
        if (value == UINT32_MAX || count == MaxWorldDelta)
            return 0;
        u32 offset = 4 * (WorldHeaderWords + count * WorldRecordWords);
        if (output) {
            if (offset + 4 * WorldRecordWords > capacity)
                return 0;
            write_word(output + offset, i);
            write_word(output + offset + 4, value);
        }
        ++count;
    }
    if (output) {
        write_word(output, WorldVersion);
        write_word(output + 4, world.count);
        write_word(output + 8, world.layout);
        write_word(output + 12, count);
    }
    return 4 * (WorldHeaderWords + count * WorldRecordWords);
}

static int read_changes(const u8* input, u32 count, WebSnapshotFindObject* find_object, int apply)
{
    u32 next = count ? read_word(input) : world.count;
    for (u32 i = 0; i < world.count; ++i) {
        const WorldField* field = &world.fields[i];
        u32 value = field->initial;
        if (i == next) {
            value = read_word(input + 4);
            input += 4 * WorldRecordWords;
            --count;
            next = count ? read_word(input) : world.count;
            if (next <= i || (count && next >= world.count) || value == field->initial)
                return 0;
        }
        if (field->kind == WorldOwner) {
            void* owner = value ? find_object(value) : NULL;
            if (value && !owner)
                return 0;
            if (apply)
                memcpy(field->address, &owner, sizeof(owner));
        } else if (field->kind == WorldShort) {
            if (value > UINT16_MAX)
                return 0;
            u16 stored = value;
            if (apply)
                memcpy(field->address, &stored, sizeof(stored));
        } else {
            if (value > UINT8_MAX)
                return 0;
            if (apply)
                *(u8*)field->address = value;
        }
    }
    return !count;
}

int WebSnapshotWorldReset(WebSnapshotFindObject* find_object)
{
    return world.fields && find_object && read_changes(NULL, 0, find_object, 0)
        && read_changes(NULL, 0, find_object, 1);
}

int WebSnapshotWorldRestore(const u8* input, u32 length, WebSnapshotFindObject* find_object)
{
    if (!world.fields || !input || length < 4 * WorldHeaderWords || !find_object
        || read_word(input) != WorldVersion || read_word(input + 4) != world.count
        || read_word(input + 8) != world.layout)
        return 0;
    u32 count = read_word(input + 12);
    if (count > MaxWorldDelta || length != 4 * (WorldHeaderWords + count * WorldRecordWords))
        return 0;
    const u8* records = input + 4 * WorldHeaderWords;
    return read_changes(records, count, find_object, 0)
        && read_changes(records, count, find_object, 1);
}

#ifdef TM4_WEB_TEST_HOOKS
EMSCRIPTEN_KEEPALIVE int WebTestPortableWorldOpen(void) { return WebSnapshotWorldOpen(); }

EMSCRIPTEN_KEEPALIVE void WebTestPortableWorldClose(void) { WebSnapshotWorldClose(); }

EMSCRIPTEN_KEEPALIVE u32 WebTestPortableWorldCapture(void)
{
    u32 length = WebSnapshotWorldCapture(NULL, 0);
    u8* bytes = length ? malloc(length) : NULL;
    if (!bytes || WebSnapshotWorldCapture(bytes, length) != length) {
        free(bytes);
        return 0;
    }
    EM_ASM({ tm4Port.testPortableWorld = HEAPU8.slice($0, $0 + $1); }, bytes, length);
    free(bytes);
    return length;
}

EMSCRIPTEN_KEEPALIVE int WebTestPortableWorldRestore(void)
{
    const u32 length = EM_ASM_INT(
        { return (tm4Port.testPortableWorld && tm4Port.testPortableWorld.length) || 0; });
    if (!length || length > 4 * (WorldHeaderWords + MaxWorldDelta * WorldRecordWords))
        return 0;
    u8* bytes = malloc(length);
    if (!bytes)
        return 0;
    EM_ASM({ HEAPU8.set(tm4Port.testPortableWorld, $0); }, bytes);
    int restored = WebSnapshotWorldRestore(bytes, length, WebSnapshotFindLiveObject);
    free(bytes);
    return restored;
}
#endif
