#include "snapshot_types.h"

#include "src/modules/levels/w_yard/private.h"

static const SnapshotCustomClass crane_control_class = {
    .destructor = (Tm4ObjectCallback)CraneControlDestructor,
    .interact = (Tm4ObjectInteractionCallback)InteractCraneControlWithOtherObject,
};

static const SnapshotField crane_fields[] = {
    SNAP_POD(Crane, transform),
    SNAP_POD(Crane, rotation_angle),
    SNAP_LOCAL(Crane, pivot),
    SNAP_LOCAL(Crane, rotation_speed_per_second),
    SNAP_LOCAL(Crane, camera_pose),
    SNAP_POD(Crane, magnet_position),
    SNAP_LOCAL(Crane, magnet_radius),
    SNAP_LOCAL(Crane, spring_force_scale),
    SNAP_LOCAL(Crane, damping_force_scale),
    SNAP_REF(Crane, held_car, "car"),
    SNAP_POD(Crane, ground_y),
    SNAP_POD(Crane, miss_effect_ticks),
    SNAP_REQUIRED(Crane, control, "craneControl"),
    SNAP_REF(Crane, rotation_sound, "soundEmitter"),
    SNAP_REF(Crane, magnet_sound, "soundEmitter"),
    { 0 },
};

static const SnapshotField crane_control_fields[] = {
    SNAP_REQUIRED(CraneControl, crane, "crane"),
    SNAP_REF(CraneControl, operator_car, "car"),
    SNAP_POD(CraneControl, saved_health),
    SNAP_LIST(CraneControl, interactions, &WebSnapshotInteractionHistory),
    { 0 },
};

static const SnapshotField death_point_fields[] = {
    SNAP_LIST(DeathPoint, interactions, &WebSnapshotInteractionHistory),
    { 0 },
};

const SnapshotType WebSnapshotYardTypes[] = {
    { "crane", sizeof(Crane), crane_fields, .needs_template = 1 },
    { "craneControl", sizeof(CraneControl), crane_control_fields, .custom = &crane_control_class },
    { "deathPoint", sizeof(DeathPoint), death_point_fields },
    { 0 },
};
