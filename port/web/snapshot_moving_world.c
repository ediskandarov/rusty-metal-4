#include "snapshot_pathing.h"

#include "src/modules/levels/w_carni/private.h"
#include "src/modules/levels/w_neon/private.h"
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

static const SnapshotField train_fields[] = {
    SNAP_POD(Train, path_speed_per_second),
    SNAP_GROUP(Train, path, &WebSnapshotPathFields),
    SNAP_POD(Train, health),
    SNAP_POD(Train, damage),
    SNAP_DERIVED(Train, box),
    SNAP_LIST(Train, interactions, &WebSnapshotInteractionHistory),
    { 0 },
};

static int train_valid(const void* payload)
{
    const Train* train = payload;
    return train->health >= -1 && train->box.polyhedron && WebSnapshotPathValid(&train->path);
}

static u32 capture_train(const void* payload, u8* output, u32 capacity)
{
    const Train* train = payload;
    return WebSnapshotPathCapture(&train->path, train, output, capacity);
}

static int restore_train(void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    Train* train = payload;
    return WebSnapshotPathRestore(&train->path, train, input, length)
        && WebSnapshotPathBoxRestore(&train->box, TrainWorldInfo);
}

static void release_train(void* payload)
{
    WebSnapshotPathBoxRelease(&((Train*)payload)->box);
}

static const SnapshotField ufo_fields[] = {
    SNAP_POD(Ufo, path_speed_per_second),
    SNAP_GROUP(Ufo, path, &WebSnapshotPathFields),
    SNAP_POD(Ufo, health),
    SNAP_DERIVED(Ufo, box),
    SNAP_POD(Ufo, spring),
    SNAP_POD(Ufo, damping),
    SNAP_REF(Ufo, car, "car"),
    SNAP_DERIVED(Ufo, pickup_world_position),
    SNAP_POD(Ufo, pickup_radius),
    SNAP_DERIVED(Ufo, drop_world_position),
    SNAP_POD(Ufo, drop_radius),
    SNAP_REF(Ufo, beam_sound, "soundEmitter"),
    { 0 },
};

static int ufo_valid(const void* payload)
{
    const Ufo* ufo = payload;
    return ufo->health >= -1 && ufo->box.polyhedron && WebSnapshotPathValid(&ufo->path)
        && ufo->car == ObjectGetHeader(ufo)->owner;
}

static u32 capture_ufo(const void* payload, u8* output, u32 capacity)
{
    const Ufo* ufo = payload;
    return WebSnapshotPathCapture(&ufo->path, ufo, output, capacity);
}

static int restore_ufo(void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    Ufo* ufo = payload;
    RegistryDirectory* instance = WebSnapshotPathRestore(&ufo->path, ufo, input, length);
    if (!instance || !WebSnapshotPathBoxRestore(&ufo->box, UfoWorldInfo))
        return 0;
    ufo->pickup_world_position = RegGetFileDataPS(instance, UfoPickupPositionKey);
    ufo->drop_world_position = RegGetFileDataPS(instance, UfoDropPositionKey);
    return 1;
}

static void release_ufo(void* payload)
{
    WebSnapshotPathBoxRelease(&((Ufo*)payload)->box);
}

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

static void release_coaster(void* payload)
{
    WebSnapshotPathBoxRelease(&((Coaster*)payload)->box);
}

const SnapshotType WebSnapshotMovingWorldTypes[] = {
    { "helicopter", sizeof(Helicopter), helicopter_fields, helicopter_valid, capture_helicopter,
        restore_helicopter, .baseline_removable = 1, .hash_fields = 1, .release = release_helicopter },
    { "train", sizeof(Train), train_fields, train_valid, capture_train, restore_train,
        .baseline_removable = 1, .hash_fields = 1, .release = release_train },
    { "ufo", sizeof(Ufo), ufo_fields, ufo_valid, capture_ufo, restore_ufo,
        .baseline_removable = 1, .hash_fields = 1, .release = release_ufo },
    { "coaster", sizeof(Coaster), coaster_fields, coaster_valid, capture_coaster, restore_coaster,
        .baseline_removable = 1, .hash_fields = 1, .release = release_coaster },
    { 0 },
};
