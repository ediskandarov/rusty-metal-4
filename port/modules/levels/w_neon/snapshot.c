#include "port/web/snapshot_pathing.h"
#include "src/modules/levels/w_neon/private.h"

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

static void release_train(void* payload) { WebSnapshotPathBoxRelease(&((Train*)payload)->box); }

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

static void release_ufo(void* payload) { WebSnapshotPathBoxRelease(&((Ufo*)payload)->box); }

const SnapshotType Tm4ModuleSnapshotTypes[] = {
    { "train", sizeof(Train), train_fields, train_valid, capture_train, restore_train,
        .baseline_removable = 1, .hash_fields = 1, .release = release_train },
    { "ufo", sizeof(Ufo), ufo_fields, ufo_valid, capture_ufo, restore_ufo, .baseline_removable = 1,
        .hash_fields = 1, .release = release_ufo },
    { 0 },
};
