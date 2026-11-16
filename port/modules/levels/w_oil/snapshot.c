#include "port/web/snapshot_pathing.h"
#include "src/modules/levels/w_oil/private.h"

static const SnapshotField helicopter_fields[] = {
    SNAP_POD(Helicopter, path_speed_per_second),
    SNAP_GROUP(Helicopter, path, &WebSnapshotPathFields),
    SNAP_POD(Helicopter, top_blade_step_per_frame),
    SNAP_POD(Helicopter, top_blade_angle),
    SNAP_POD(Helicopter, top_blade_rotation.m),
    SNAP_POD(Helicopter, top_blade_rotation.t),
    SNAP_POD(Helicopter, tail_blade_step_per_frame),
    SNAP_POD(Helicopter, tail_blade_angle),
    SNAP_POD(Helicopter, tail_blade_rotation.m),
    SNAP_POD(Helicopter, tail_blade_rotation.t),
    SNAP_POD(Helicopter, health),
    SNAP_DERIVED(Helicopter, box),
    SNAP_REF(Helicopter, health_powerup, "powerup"),
    { 0 },
};

static int helicopter_valid(const void* payload)
{
    const Helicopter* helicopter = payload;
    return helicopter->health >= -1 && helicopter->box.polyhedron
        && WebSnapshotPathValid(&helicopter->path);
}

static u32 capture_helicopter(const void* payload, u8* output, u32 capacity)
{
    const Helicopter* helicopter = payload;
    return WebSnapshotPathCapture(&helicopter->path, helicopter, output, capacity);
}

static void release_helicopter(void* payload)
{
    Helicopter* helicopter = payload;
    WebSnapshotPathBoxRelease(&helicopter->box);
}

static int restore_helicopter(
    void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    Helicopter* helicopter = payload;
    return WebSnapshotPathRestore(&helicopter->path, helicopter, input, length)
        && WebSnapshotPathBoxRestore(&helicopter->box, HelicopterWorldInfo);
}

const SnapshotType Tm4ModuleSnapshotTypes[] = {
    { "helicopter", sizeof(Helicopter), helicopter_fields, helicopter_valid, capture_helicopter,
        restore_helicopter, .baseline_removable = 1, .hash_fields = 1,
        .release = release_helicopter },
    { 0 },
};
