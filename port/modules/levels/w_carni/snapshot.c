#include "port/web/snapshot_pathing.h"
#include "src/modules/levels/w_carni/private.h"

static const SnapshotField coaster_fields[] = {
    SNAP_POD(Coaster, path_speed_per_second),
    SNAP_GROUP(Coaster, path, &WebSnapshotPathFields),
    SNAP_POD(Coaster, health),
    SNAP_POD(Coaster, damage),
    SNAP_DERIVED(Coaster, box),
    SNAP_LIST(Coaster, interactions, &WebSnapshotInteractionHistory),
    { 0 },
};

static int coaster_valid(const void* payload)
{
    const Coaster* coaster = payload;
    return coaster->health >= -1 && coaster->box.polyhedron && WebSnapshotPathValid(&coaster->path);
}

static u32 capture_coaster(const void* payload, u8* output, u32 capacity)
{
    const Coaster* coaster = payload;
    return WebSnapshotPathCapture(&coaster->path, coaster, output, capacity);
}

static int restore_coaster(void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    Coaster* coaster = payload;
    return WebSnapshotPathRestore(&coaster->path, coaster, input, length)
        && WebSnapshotPathBoxRestore(&coaster->box, CoasterWorldInfo);
}

static void release_coaster(void* payload) { WebSnapshotPathBoxRelease(&((Coaster*)payload)->box); }

const SnapshotType Tm4ModuleSnapshotTypes[] = {
    { "coaster", sizeof(Coaster), coaster_fields, coaster_valid, capture_coaster, restore_coaster,
        .baseline_removable = 1, .hash_fields = 1, .release = release_coaster },
    { 0 },
};
