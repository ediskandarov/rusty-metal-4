#include "snapshot.h"

#include "checkpoint.h"
#include "checkpoint_memory.h"
#include "net_state.h"
#include "snapshot_session.h"
#include "snapshot_world.h"
#include "snapshot_types.h"
#include "src/main/object/private.h"
#include "tm4/main/main.h"

#include <stdlib.h>
#include <string.h>

enum { SnapshotVersion = 11, MaxObjects = 2048 };

typedef struct {
    u32 version, count, session_bytes, world_bytes;
    u32 hashes[5];
} SnapshotHeader;

typedef struct {
    u32 header_bytes, payload_bytes;
} ObjectSizes;

typedef struct {
    u32 handle;
    const u8* header;
    const u8* payload;
    ObjectSizes size;
    const SnapshotType* type;
    Tm4ObjectHeader* object;
} GraphObject;

static GraphObject* restoring_objects;
static u32 restoring_count;

static void hashes(u32* values, const WebNetStateDigest* digest)
{
    values[0] = digest->session;
    values[1] = digest->cars;
    values[2] = digest->objects;
    values[3] = digest->world;
    values[4] = digest->sound;
}

u32 WebSnapshotCapture(u8* output, u32 capacity, const char** blocker)
{
    const WebNetStateDigest digest = WebNetCaptureDigest(1);
    if (digest.unsupported || !output || capacity > WebSnapshotMaxBytes
        || capacity < sizeof(SnapshotHeader)) {
        *blocker = digest.unsupported ? digest.unsupported : "snapshot capacity";
        return 0;
    }
    SnapshotHeader snapshot = { .version = SnapshotVersion };
    hashes(snapshot.hashes, &digest);
    u32 length = sizeof(snapshot);
    snapshot.session_bytes = WebSnapshotSessionCapture(output + length, capacity - length);
    if (!snapshot.session_bytes) {
        *blocker = "session roots";
        return 0;
    }
    length += snapshot.session_bytes;
    snapshot.world_bytes = WebSnapshotWorldCapture(output + length, capacity - length);
    if (!snapshot.world_bytes) {
        *blocker = "world mutations";
        return 0;
    }
    length += snapshot.world_bytes;
    for (unsigned i = 0; i < OBJECT_LIST_COUNT; ++i) {
        for (const Tm4ObjectHeader* object = ObjectLists[i].first; object; object = object->next) {
            ObjectSizes sizes;
            if (snapshot.count == MaxObjects || capacity - length < sizeof(sizes)) {
                *blocker = "object capacity";
                return 0;
            }
            const u32 start = length;
            length += sizeof(sizes);
            if (!WebSnapshotExtenderGroupValid(object)) {
                *blocker = "interaction extender ownership";
                return 0;
            }
            sizes.header_bytes
                = WebSnapshotObjectCapture(object, output + length, capacity - length);
            if (!sizes.header_bytes) {
                *blocker = object->name;
                return 0;
            }
            length += sizes.header_bytes;
            const SnapshotType* type = WebSnapshotObjectType(object);
            sizes.payload_bytes = type ? WebSnapshotFieldsCapture(type, ObjectGetPayload(object),
                                             output + length, capacity - length)
                                       : 0;
            if (!sizes.payload_bytes) {
                *blocker = object->name;
                return 0;
            }
            length += sizes.payload_bytes;
            memcpy(output + start, &sizes, sizeof(sizes));
            ++snapshot.count;
        }
    }
    memcpy(output, &snapshot, sizeof(snapshot));
    *blocker = NULL;
    return length;
}

static int compare_handles(const void* left, const void* right)
{
    const GraphObject* a = left;
    const GraphObject* b = right;
    return (a->handle > b->handle) - (a->handle < b->handle);
}

static GraphObject* lookup(u32 handle)
{
    GraphObject key = { .handle = handle };
    return handle ? bsearch(&key, restoring_objects, restoring_count, sizeof(*restoring_objects),
                        compare_handles)
                  : NULL;
}

static void* find_payload(u32 handle)
{
    GraphObject* entry = lookup(handle);
    return entry && entry->object ? ObjectGetPayload(entry->object) : NULL;
}

static int read_objects(GraphObject* objects, u32 count, const u8* input, u32 length)
{
    for (u32 i = 0; i < count; ++i) {
        GraphObject* entry = &objects[i];
        if (length < sizeof(entry->size))
            return 0;
        memcpy(&entry->size, input, sizeof(entry->size));
        input += sizeof(entry->size);
        length -= sizeof(entry->size);
        if (!entry->size.header_bytes || entry->size.header_bytes > length)
            return 0;
        entry->header = input;
        input += entry->size.header_bytes;
        length -= entry->size.header_bytes;
        const char* name;
        if (!entry->size.payload_bytes || entry->size.payload_bytes > length
            || !WebSnapshotObjectIdentify(
                entry->header, entry->size.header_bytes, &name, &entry->handle))
            return 0;
        entry->type = WebSnapshotTypeByName(name);
        if (!entry->type)
            return 0;
        entry->payload = input;
        input += entry->size.payload_bytes;
        length -= entry->size.payload_bytes;
    }
    if (length)
        return 0;
    qsort(objects, count, sizeof(*objects), compare_handles);
    for (u32 i = 1; i < count; ++i)
        if (objects[i - 1].handle == objects[i].handle)
            return 0;
    return 1;
}

static int collect_baseline(Tm4ObjectHeader** baseline)
{
    int count = 0;
    for (unsigned i = 0; i < OBJECT_LIST_COUNT; ++i) {
        for (Tm4ObjectHeader* object = ObjectLists[i].first; object; object = object->next) {
            if (count == MaxObjects)
                return -1;
            baseline[count++] = object;
            GraphObject* entry = lookup((u32)object->serial + 1);
            if (entry) {
                if (entry->type != WebSnapshotObjectType(object))
                    return -1;
                entry->object = object;
            }
        }
    }
    return count;
}

static void release_baseline(Tm4ObjectHeader* object)
{
    void* payload = ObjectGetPayload(object);
    const SnapshotType* description = WebSnapshotObjectType(object);
    if (description)
        WebSnapshotFieldsRelease(description, payload);
    if (object->class_index == -1)
        MemFree(object->name);
    MemFree(object);
}

static int apply_snapshot(const SnapshotHeader* snapshot, const u8* session, const u8* world,
    Tm4ObjectHeader** baseline, u32 baseline_count, const char** blocker)
{
    *blocker = "session membership";
    if (!WebSnapshotSessionPrepare(session, snapshot->session_bytes))
        return 0;
    for (u32 i = 0; i < restoring_count; ++i) {
        GraphObject* entry = &restoring_objects[i];
        *blocker = entry->type->name;
        if (!entry->object) {
            if (entry->type->needs_template)
                return 0;
            entry->object = WebSnapshotObjectAllocate(entry->header, entry->size.header_bytes);
            if (!entry->object || entry->type != WebSnapshotObjectType(entry->object))
                return 0;
        }
    }
    for (u32 i = 0; i < baseline_count; ++i) {
        Tm4ObjectHeader* object = baseline[i];
        const SnapshotType* type = WebSnapshotObjectType(object);
        if (!lookup((u32)object->serial + 1) && (!type || !type->baseline_removable)) {
            *blocker = object->name;
            return 0;
        }
    }
    for (u32 i = 0; i < restoring_count; ++i) {
        GraphObject* entry = &restoring_objects[i];
        *blocker = entry->type->name;
        if (!WebSnapshotObjectBind(
                entry->object, entry->header, entry->size.header_bytes, find_payload))
            return 0;
    }
    for (u32 i = 0; i < restoring_count; ++i) {
        GraphObject* entry = &restoring_objects[i];
        *blocker = entry->type->name;
        if (!WebSnapshotFieldsRestore(entry->type, ObjectGetPayload(entry->object), entry->payload,
                entry->size.payload_bytes, find_payload))
            return 0;
    }
    *blocker = "interaction extender ownership";
    for (u32 i = 0; i < restoring_count; ++i)
        if (!WebSnapshotExtenderGroupValid(restoring_objects[i].object))
            return 0;
    *blocker = "session root references";
    if (!WebSnapshotSessionRestore(session, snapshot->session_bytes, find_payload))
        return 0;
    u32 linked = 0;
    for (unsigned i = 0; i < OBJECT_LIST_COUNT; ++i)
        for (const Tm4ObjectHeader* object = ObjectLists[i].first; object; object = object->next)
            ++linked;
    if (linked != restoring_count)
        return 0;
    *blocker = "world mutation references";
    if (!WebSnapshotWorldRestore(world, snapshot->world_bytes, find_payload))
        return 0;
    u32 restored[5];
    const WebNetStateDigest digest = WebNetCaptureDigest(1);
    hashes(restored, &digest);
    if (digest.unsupported || memcmp(snapshot->hashes, restored, sizeof(restored))) {
        *blocker = digest.unsupported ? digest.unsupported : "snapshot checksum";
        return 0;
    }
    for (u32 i = 0; i < baseline_count; ++i) {
        Tm4ObjectHeader* object = baseline[i];
        if (!lookup((u32)object->serial + 1))
            release_baseline(object);
    }
    *blocker = NULL;
    return 1;
}

int WebSnapshotRestore(const u8* input, u32 length, const char** blocker)
{
    SnapshotHeader snapshot;
    *blocker = "snapshot structure";
    if (restoring_objects || MainFrameCount || !input || length < sizeof(snapshot)
        || length > WebSnapshotMaxBytes)
        return 0;
    memcpy(&snapshot, input, sizeof(snapshot));
    input += sizeof(snapshot);
    length -= sizeof(snapshot);
    if (snapshot.version != SnapshotVersion || !snapshot.count || snapshot.count > MaxObjects
        || !snapshot.session_bytes || snapshot.session_bytes > length || !snapshot.world_bytes
        || snapshot.world_bytes > length - snapshot.session_bytes)
        return 0;
    const u8* world = input + snapshot.session_bytes;
    const u32 prefix = snapshot.session_bytes + snapshot.world_bytes;
    restoring_objects = calloc(snapshot.count, sizeof(*restoring_objects));
    Tm4ObjectHeader** baseline = malloc(MaxObjects * sizeof(*baseline));
    int result = 0;
    if (restoring_objects && baseline
        && read_objects(restoring_objects, snapshot.count, input + prefix, length - prefix)) {
        restoring_count = snapshot.count;
        int count = collect_baseline(baseline);
        if (count >= 0 && WebCheckpointCapture(0, 0)) {
            WebCheckpointArenaSelect(1);
            result = apply_snapshot(&snapshot, input, world, baseline, count, blocker);
            WebCheckpointArenaSelect(0);
            if (!result) {
                const char* reason = WebCheckpointRestore(0);
                if (reason || !WebSnapshotWorldReset(WebSnapshotFindLiveObject))
                    *blocker = "portable restore could not reset the initial world";
            }
            WebCheckpointDiscard();
        }
    }
    free(baseline);
    free(restoring_objects);
    restoring_objects = NULL;
    restoring_count = 0;
    return result;
}
