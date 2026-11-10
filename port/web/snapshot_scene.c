#include "snapshot_types.h"

#include "src/main/object/private.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/car.h"
#include "tm4/modules/conveyer.h"
#include "tm4/modules/destry.h"
#include "tm4/modules/jumppad.h"
#include "tm4/modules/powerup.h"
#include "tm4/modules/tele.h"

#include <stdint.h>
#include <string.h>

void ObjectInteractionExtenderProcess(Tm4InteractionExtender* object);
void ObjectInteractionExtenderDestructor(Tm4InteractionExtender* object);

static const SnapshotCustomClass extender_class = {
    .process = (Tm4ObjectCallback)ObjectInteractionExtenderProcess,
    .destructor = (Tm4ObjectCallback)ObjectInteractionExtenderDestructor,
};

static const SnapshotField interaction_fields[] = {
    SNAP_REQUIRED(Tm4InteractionNode, payload, NULL),
    SNAP_POD(Tm4InteractionNode, stamp),
    { 0 },
};

const SnapshotList WebSnapshotInteractionHistory = {
    interaction_fields,
    sizeof(Tm4InteractionNode),
    offsetof(Tm4InteractionNode, next),
    64,
};

static const SnapshotField seen_fields[] = {
    SNAP_HEADER(Tm4ExtenderSeen, object),
    { 0 },
};

static const SnapshotList seen = {
    seen_fields,
    sizeof(Tm4ExtenderSeen),
    offsetof(Tm4ExtenderSeen, next),
    64,
};

static const SnapshotField powerup_fields[] = {
    SNAP_LOCAL_KEY(PowerupState, name),
    SNAP_POD(PowerupState, units),
    SNAP_POD(PowerupState, inactive_ticks),
    SNAP_POD(PowerupState, angle),
    SNAP_POD(PowerupState, respawn_delay_ticks),
    SNAP_POD(PowerupState, base_height),
    SNAP_POD(PowerupState, bob_phase_angle),
    SNAP_POD(PowerupState, position),
    SNAP_LOCAL(PowerupState, interact),
    SNAP_LOCAL(PowerupState, sound),
    SNAP_LOCAL(PowerupState, part),
    { 0 },
};

static int powerup_valid(const void* payload)
{
    const PowerupState* powerup = payload;
    return powerup->name && powerup->position.fields.active <= POWERUP_AVAILABLE;
}

static const SnapshotField teleporter_fields[] = {
    SNAP_LOCAL(Teleporter, destination_world),
    SNAP_LOCAL(Teleporter, destination_forward_world),
    SNAP_TRANSIENT(Teleporter, billboard_to_camera),
    SNAP_POD(Teleporter, billboard_size),
    SNAP_POD(Teleporter, texture_frame),
    SNAP_POD(Teleporter, billboard_roll),
    SNAP_POD(Teleporter, size_phase),
    SNAP_POD(Teleporter, animation_age_frames),
    SNAP_LOCAL(Teleporter, color),
    { 0 },
};

static const SnapshotField camera_fields[] = {
    SNAP_POD(Camera, camera_to_world),
    SNAP_POD(Camera, world_to_camera),
    SNAP_POD(Camera, previous_camera_to_world),
    SNAP_DERIVED(Camera, object),
    SNAP_DERIVED(Camera, data),
    SNAP_DERIVED(Camera, process),
    { 0 },
};

typedef struct {
    u32 target;
    s32 orbit_yaw, snap, distance_preset;
} CameraBinding;

static u32 capture_camera(const void* payload, u8* output, u32 capacity)
{
    const Camera* camera = payload;
    CameraBinding binding = { .target = WebSnapshotLiveHandle(camera->object) };
    if (capacity < sizeof(binding) || binding.target == UINT32_MAX)
        return 0;
    if (camera->object) {
        const char* target = ObjectGetHeader(camera->object)->name;
        if (!strcmp(target, "car") && camera->data) {
            const CarCameraState* state = camera->data;
            binding.orbit_yaw = state->orbit_yaw;
            binding.snap = state->snap;
            binding.distance_preset = state->distance_preset;
        } else if (strcmp(target, "crane") || camera->data)
            return 0;
    }
    memcpy(output, &binding, sizeof(binding));
    return sizeof(binding);
}

static int restore_camera(void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    Camera* camera = payload;
    CameraBinding binding;
    if (length != sizeof(binding))
        return 0;
    memcpy(&binding, input, sizeof(binding));
    void* target = binding.target ? find(binding.target) : NULL;
    if (binding.target
        && (!target
            || (strcmp(ObjectGetHeader(target)->name, "car")
                && strcmp(ObjectGetHeader(target)->name, "crane"))))
        return 0;
    if ((u32)binding.distance_preset >= 3 || !CameraSetObject(camera, target))
        return 0;
    if (camera->data) {
        CarCameraState* state = camera->data;
        state->orbit_yaw = binding.orbit_yaw;
        state->snap = binding.snap;
        state->distance_preset = binding.distance_preset;
    }
    return 1;
}

static const SnapshotField car_jump_fields[] = {
    SNAP_REQUIRED(CarJump, car, "car"),
    SNAP_POD(CarJump, world_position),
    SNAP_POD(CarJump, frame_displacement),
    SNAP_POD(CarJump, frames_left),
    { 0 },
};

static const SnapshotField extender_fields[] = {
    SNAP_REQUIRED(Tm4InteractionExtender, next, OBJECT_INTERACTION_EXTENDER_NAME),
    SNAP_POD(Tm4InteractionExtender, dx),
    SNAP_POD(Tm4InteractionExtender, dz),
    SNAP_LIST(Tm4InteractionExtender, seen, &seen),
    { 0 },
};

static const SnapshotField destroyable_fields[] = {
    SNAP_POD(Destroyable, hit_points),
    SNAP_LOCAL(Destroyable, sound_name),
    SNAP_LOCAL(Destroyable, registry),
    SNAP_LOCAL(Destroyable, world),
    SNAP_LIST(Destroyable, interactions, &WebSnapshotInteractionHistory),
    { 0 },
};

static int destroyable_valid(const void* payload)
{
    return ((const Destroyable*)payload)->hit_points > 0;
}

static const SnapshotField jumppad_fields[] = {
    SNAP_LOCAL(Jumppad, direction),
    SNAP_LOCAL(Jumppad, acceleration),
    SNAP_LIST(Jumppad, interaction_list, &WebSnapshotInteractionHistory),
    SNAP_LOCAL(Jumppad, one_way),
    { 0 },
};

static const SnapshotField conveyer_fields[] = {
    SNAP_LOCAL(Conveyer, world),
    SNAP_LOCAL(Conveyer, speed),
    { 0 },
};

const SnapshotType WebSnapshotSceneTypes[] = {
    { "powerup", sizeof(PowerupState), powerup_fields, powerup_valid, .needs_template = 1 },
    { "teleporter", sizeof(Teleporter), teleporter_fields, .needs_template = 1 },
    { "camera", sizeof(Camera), camera_fields, NULL, capture_camera, restore_camera },
    { "carJump", sizeof(CarJump), car_jump_fields },
    { OBJECT_INTERACTION_EXTENDER_NAME, sizeof(Tm4InteractionExtender), extender_fields,
        .custom = &extender_class },
    { "destroyable", sizeof(Destroyable), destroyable_fields, destroyable_valid,
        .needs_template = 1, .baseline_removable = 1 },
    { "jumppad", sizeof(Jumppad), jumppad_fields, .needs_template = 1 },
    { "conveyer", sizeof(Conveyer), conveyer_fields, .needs_template = 1 },
    { 0 },
};
