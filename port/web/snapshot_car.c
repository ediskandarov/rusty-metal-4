#include "snapshot_types.h"

#include "src/modules/car/private.h"

#include <stdint.h>
#include <string.h>

static u32 wheel_count(const void* payload)
{
    const Car* car = payload;
    return car->wheel_end - car->wheels + 1;
}

static u32 particle_count(const void* payload)
{
    const Car* car = payload;
    return car->particle_end - car->particles;
}

static u32 spring_count(const void* payload)
{
    const Car* car = payload;
    return car->spring_end - car->springs;
}

static u32 weapon_count(const void* payload) { return CarWeaponCount; }

static const SnapshotField wheel_fields[] = {
    SNAP_LOCAL(CarWheel, response_particle),
    SNAP_LOCAL(CarWheel, group),
    SNAP_POD(CarWheel, direction),
    SNAP_LOCAL(CarWheel, radius),
    SNAP_LOCAL(CarWheel, width),
    SNAP_POD(CarWheel, force),
    SNAP_POD(CarWheel, velocity),
    SNAP_POD(CarWheel, friction_limit),
    SNAP_POD(CarWheel, torque),
    SNAP_POD(CarWheel, angular_velocity),
    SNAP_POD(CarWheel, rotation),
    SNAP_POD(CarWheel, steering),
    SNAP_LOCAL(CarWheel, inverse_inertia_step_q18),
    SNAP_LOCAL(CarWheel, gear_inverse_inertia_step_q18),
    SNAP_LOCAL(CarWheel, uses_axis),
    SNAP_LOCAL(CarWheel, driven),
    SNAP_TRANSIENT(CarWheel, unknown4a),
    SNAP_TRANSIENT(CarWheel, unknown4b),
    { 0 },
};
static const SnapshotArray wheels = { wheel_fields, sizeof(CarWheel), wheel_count, 4 };

static const SnapshotField particle_fields[] = {
    SNAP_LOCAL(CarParticle, mass),
    SNAP_POD(CarParticle, previous_position),
    SNAP_POD(CarParticle, position),
    SNAP_POD(CarParticle, world_position_q12),
    SNAP_POD(CarParticle, velocity_q12),
    SNAP_POD(CarParticle, net_force),
    SNAP_POD(CarParticle, spring_force),
    SNAP_POD(CarParticle, external_force),
    SNAP_LOCAL(CarParticle, response_wheel),
    SNAP_POD(CarParticle, normal),
    SNAP_POD(CarParticle, contact_state),
    SNAP_TRANSIENT(CarParticle, unknown5e),
    SNAP_POD(CarParticle, material),
    SNAP_POD(CarParticle, surface_velocity_q12),
    SNAP_POD(CarParticle, slip_speed_q12),
    SNAP_POD(CarParticle, gravity),
    SNAP_LOCAL(CarParticle, inverse_mass_step_q18),
    SNAP_LOCAL(CarParticle, mass_per_step_q12),
    { 0 },
};
static const SnapshotArray particles = {
    particle_fields,
    sizeof(CarParticle),
    particle_count,
    5,
};

static const SnapshotField spring_fields[] = {
    SNAP_LOCAL(CarSpring, first),
    SNAP_LOCAL(CarSpring, second),
    SNAP_LOCAL(CarSpring, rest_length_q12),
    SNAP_LOCAL(CarSpring, kind),
    SNAP_TRANSIENT(CarSpring, unknown0d),
    SNAP_POD(CarSpring, direction),
    { 0 },
};
static const SnapshotArray springs = { spring_fields, sizeof(CarSpring), spring_count, 10 };

static const SnapshotField weapon_fields[] = {
    SNAP_POD(CarWeaponInstance, amount),
    SNAP_LOCAL(CarWeaponInstance, count),
    SNAP_POD(CarWeaponInstance, index),
    SNAP_POD(CarWeaponInstance, active),
    SNAP_POD(CarWeaponInstance, next_time),
    SNAP_LOCAL(CarWeaponInstance, launchers),
    SNAP_LOCAL(CarWeaponInstance, descriptor),
    { 0 },
};
static const SnapshotArray weapons = {
    weapon_fields,
    sizeof(CarWeaponInstance),
    weapon_count,
    64,
};

static const SnapshotField contact_fields[] = {
    SNAP_REQUIRED(CarCollisionHistory, other, "car"),
    SNAP_POD(CarCollisionHistory, time),
    { 0 },
};
static const SnapshotList contacts = {
    contact_fields,
    sizeof(CarCollisionHistory),
    offsetof(CarCollisionHistory, next),
    32,
};

static const SnapshotField driver_location_fields[] = {
    SNAP_POD(CarAiRuntime, update_slot),
    SNAP_POD(CarAiRuntime, update_phase),
    SNAP_POD(CarAiRuntime, health_fraction),
    SNAP_POD(CarAiRuntime, position),
    SNAP_POD(CarAiRuntime, probe_center),
    SNAP_POD(CarAiRuntime, probe_direction),
    SNAP_POD(CarAiRuntime, path_direction),
    SNAP_POD(CarAiRuntime, node_direction),
    SNAP_POD(CarAiRuntime, node_distance),
    SNAP_POD(CarAiRuntime, selected_node),
    SNAP_POD(CarAiRuntime, previous_node),
    SNAP_POD(CarAiRuntime, probe_length),
    SNAP_DERIVED(CarAiRuntime, area),
    SNAP_DERIVED(CarAiRuntime, spatial_node),
    SNAP_REF(CarAiRuntime, target, "car"),
    { 0 },
};
static const SnapshotGroupFields driver_location = { driver_location_fields, NULL };

/* Bot steering, plans and target lists are inactive with CarPlayerInput. The
 * common navigation probe still runs for human cars when the map has AI data. */
static const SnapshotField car_fields[] = {
    SNAP_LOCAL(Car, display_list_count),
    SNAP_LOCAL(Car, display_lists),
    SNAP_LOCAL(Car, faces),
    SNAP_LOCAL(Car, vertices),
    SNAP_LOCAL(Car, normals),
    SNAP_LOCAL(Car, normal_count),
    SNAP_LOCAL(Car, colors),
    SNAP_LOCAL(Car, render_callback),
    SNAP_LOCAL(Car, shadow_texture),
    SNAP_POD(Car, frame),
    SNAP_POD(Car, light_level),
    SNAP_POD(Car, light_boost),
    SNAP_TRANSIENT(Car, original_faces),
    SNAP_TRANSIENT(Car, original_colors),
    SNAP_TRANSIENT(Car, invisibility_hidden),
    SNAP_LOCAL(Car, turbo_emitter_count),
    SNAP_LOCAL(Car, turbo_emitters),
    SNAP_POD(Car, turbo_amount),
    SNAP_LOCAL(Car, turbo_light_offset),
    SNAP_REF(Car, turbo_light, "lightEmitter"),
    SNAP_POD(Car, world_light_matrix),
    SNAP_POD(Car, color_matrix),
    SNAP_POD(Car, background_red),
    SNAP_POD(Car, background_green),
    SNAP_POD(Car, background_blue),
    SNAP_POD(Car, lights),
    SNAP_POD(Car, invisibility_ticks),
    SNAP_POD(Car, shield_ticks),
    SNAP_ARRAY(Car, wheels, &wheels),
    SNAP_LOCAL(Car, wheel_end),
    SNAP_LOCAL(Car, physics_box),
    SNAP_LOCAL(Car, collision_box),
    SNAP_POD(Car, transform),
    SNAP_POD(Car, previous_transform),
    SNAP_POD(Car, position),
    SNAP_POD(Car, previous_position),
    SNAP_ARRAY(Car, particles, &particles),
    SNAP_LOCAL(Car, particle_end),
    SNAP_ARRAY(Car, springs, &springs),
    SNAP_LOCAL(Car, spring_end),
    SNAP_LOCAL(Car, angle_constraints),
    SNAP_LOCAL(Car, angle_constraint_end),
    SNAP_LOCAL(Car, gear_coefficients),
    SNAP_LOCAL(Car, axle_torque_limit),
    SNAP_POD(Car, axle_torque),
    SNAP_POD(Car, wheel_friction_limit),
    SNAP_TRANSIENT(Car, active_collision_particle),
    SNAP_TRANSIENT(Car, active_collision_hit),
    SNAP_POD(Car, force_scale),
    SNAP_LOCAL(Car, display_speed_scale),
    SNAP_POD(Car, inverted_ticks),
    SNAP_POD(Car, recovery_ticks),
    SNAP_POD(Car, contact_count),
    SNAP_POD(Car, contact_countdown),
    SNAP_LOCAL(Car, mass_bottom),
    SNAP_LOCAL(Car, mass_top),
    SNAP_LOCAL(Car, wheel_drive),
    SNAP_LOCAL(Car, front_friction_advantage),
    SNAP_LOCAL(Car, rear_friction_advantage),
    SNAP_LOCAL(Car, ebrake_friction_scale),
    SNAP_LOCAL(Car, turbo_engine_multiplier),
    SNAP_LOCAL(Car, turbo_axle_friction_multiplier),
    SNAP_LOCAL(Car, turbo_midair_force),
    SNAP_LOCAL(Car, turbo_midair_damping),
    SNAP_LOCAL(Car, gear_radius),
    SNAP_LOCAL(Car, idle_axle_torque),
    SNAP_LOCAL(Car, maximum_axle_torque),
    SNAP_LOCAL(Car, engine_axle_friction),
    SNAP_LOCAL(Car, wheel_axle_friction_torque),
    SNAP_LOCAL(Car, maximum_brake_static_torque),
    SNAP_LOCAL(Car, maximum_brake_kinetic_torque),
    SNAP_LOCAL(Car, physics_box_height),
    SNAP_LOCAL(Car, physics_box_width),
    SNAP_LOCAL(Car, physics_box_length),
    SNAP_LOCAL(Car, damage_give_factor),
    SNAP_LOCAL(Car, damage_receive_factor),
    SNAP_LOCAL(Car, midair_rotation_per_frame),
    SNAP_LOCAL(Car, midair_steering_height_threshold),
    SNAP_TRANSIENT(Car, unknownb56),
    SNAP_LOCAL(Car, index),
    SNAP_LOCAL(Car, controller_index),
    SNAP_LOCAL_KEY(Car, character_name),
    SNAP_LOCAL(Car, name),
    SNAP_LOCAL(Car, filename),
    SNAP_LOCAL(Car, radar_color),
    SNAP_LOCAL(Car, engine_sound_name),
    SNAP_LOCAL(Car, special_sound_name),
    SNAP_POD(Car, force_sum),
    SNAP_POD(Car, display_speed),
    SNAP_REF(Car, fire_effect, "anim"),
    SNAP_POD(Car, fire_ticks),
    SNAP_POD(Car, turbo_fuel),
    SNAP_LOCAL(Car, maximum_turbo_fuel),
    SNAP_POD(Car, energy),
    SNAP_LOCAL(Car, maximum_energy),
    SNAP_POD(Car, health),
    SNAP_LOCAL(Car, maximum_health),
    SNAP_POD(Car, freeze_ticks),
    SNAP_LOCAL(Car, muzzle_records),
    SNAP_LOCAL(Car, muzzle_count),
    SNAP_POD(Car, muzzle_index),
    SNAP_POD(Car, muzzle_cooldown),
    SNAP_POD(Car, muzzle_emitted),
    SNAP_REF(Car, turbo_sound, "soundEmitter"),
    SNAP_REF(Car, invisibility_sound, "soundEmitter"),
    SNAP_REF(Car, freeze_sound, "soundEmitter"),
    SNAP_REF(Car, shield_sound, "soundEmitter"),
    SNAP_REF(Car, engine_sound, "soundEmitter"),
    SNAP_LIST(Car, collision_history, &contacts),
    SNAP_LOCAL(Car, ai_config),
    SNAP_DERIVED(Car, ai_input_callback),
    SNAP_DERIVED(Car, ai_saved_input_callback),
    SNAP_LOCAL(Car, ai_state_callback),
    SNAP_LOCAL(Car, ai_saved_state_callback),
    SNAP_LOCAL(Car, control_kind),
    SNAP_TRANSIENT(Car, ai_throttle_input),
    SNAP_TRANSIENT(Car, ai_brake_input),
    SNAP_TRANSIENT(Car, unknownc8f),
    SNAP_GROUP(Car, ai, &driver_location),
    SNAP_POD(Car, special_regeneration_ticks),
    SNAP_POD(Car, special_regeneration_interval),
    SNAP_LOCAL_ARRAY(Car, weapons, &weapons),
    SNAP_POD(Car, controls),
    SNAP_TRANSIENT(Car, callback_context),
    SNAP_TRANSIENT(Car, process_callback),
    SNAP_TRANSIENT(Car, collision_callback),
    SNAP_TRANSIENT(Car, destructor_callback),
    { 0 },
};

static int car_valid(const void* payload)
{
    const Car* car = payload;
    if (car->control_kind != CAR_CONTROL_PLAYER || !car->weapons || !car->character_name
        || !((car->ai_input_callback == CarPlayerInput && !car->ai_saved_input_callback)
            || (!car->ai_input_callback && car->ai_saved_input_callback == CarPlayerInput))
        || car->ai_state_callback != CarAiApproachTarget || car->ai_saved_state_callback
        || car->callback_context || car->process_callback || car->collision_callback
        || car->destructor_callback || car->active_collision_particle || car->active_collision_hit
        || car->original_faces || car->original_colors || car->invisibility_hidden
        || car->ai.target_entry || car->ai.nearby_list || car->ai.targeting_count
        || car->health <= 0 || car->health > car->maximum_health
        || car->controls.gear < CAR_GEAR_REVERSE || car->controls.gear > CAR_GEAR_FOURTH
        || car->controls.action < CarActionNone || car->controls.action >= CarActionCount
        || car->controls.selected_weapon < 0 || car->controls.selected_weapon >= CarWeaponCount
        || car->controls.selected_weapon_slot < 0
        || car->controls.selected_weapon_slot >= CarWeaponCount
        || (car->frame != CAR_RENDER_FRAME_INTACT && car->frame != CAR_RENDER_FRAME_DAMAGED)
        || CarWeaponCount <= 0 || (u32)CarWeaponCount > weapons.limit || !wheel_count(car)
        || wheel_count(car) > wheels.limit || particle_count(car) > particles.limit
        || spring_count(car) > springs.limit)
        return 0;

    /* Suspension temporarily borrows a wheel for body contact within a step. */
    for (u32 i = 0; i < wheel_count(car); ++i)
        if (car->wheels[i].response_particle != &car->particles[i]
            || car->particles[i].response_wheel != &car->wheels[i])
            return 0;
    if (car->particles[4].response_wheel)
        return 0;
    for (s32 i = 0; i < CarWeaponCount; ++i) {
        const CarWeaponInstance* weapon = &car->weapons[i];
        if (!weapon->descriptor || weapon->index < 0 || weapon->index > weapon->count
            || weapon->active < 0 || weapon->active > 1)
            return 0;
    }
    u32 count = 0;
    for (const CarCollisionHistory* node = car->collision_history; node; node = node->next)
        if (node->other == car || ++count > contacts.limit)
            return 0;
    return 1;
}

typedef struct {
    u16 area, node;
    u8 suspended;
} DriverBinding;

static u32 capture_driver(const void* payload, u8* output, u32 capacity)
{
    const Car* car = payload;
    if (capacity < sizeof(DriverBinding) || !car->ai.area)
        return 0;
    DriverBinding binding;
    memset(&binding, 0, sizeof(binding));
    binding.suspended = !car->ai_input_callback;
    for (u32 i = 0; i < ArrayCount(aiWorldInfo.areas); ++i)
        if (car->ai.area == &aiWorldInfo.areas[i])
            binding.area = i + 1;
    if (!binding.area)
        return 0;
    const uintptr_t offset = (uintptr_t)car->ai.spatial_node - (uintptr_t)car->ai.area->nodes;
    if (car->ai.spatial_node) {
        if (offset % sizeof(CarAiSpatialNode)
            || offset / sizeof(CarAiSpatialNode) >= car->ai.area->node_count)
            return 0;
        binding.node = offset / sizeof(CarAiSpatialNode) + 1;
    }
    memcpy(output, &binding, sizeof(binding));
    return sizeof(binding);
}

static int restore_driver(void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    Car* car = payload;
    DriverBinding binding;
    if (length != sizeof(binding))
        return 0;
    memcpy(&binding, input, sizeof(binding));
    if (!binding.area || binding.area > ArrayCount(aiWorldInfo.areas) || binding.suspended > 1)
        return 0;
    CarAiArea* area = &aiWorldInfo.areas[binding.area - 1];
    if (binding.node > area->node_count || (binding.node && !area->nodes)
        || (aiWorldInfo.enabled
            && (!binding.node || binding.area > aiWorldInfo.resource.area_count)))
        return 0;
    car->ai.area = area;
    car->ai.spatial_node = binding.node ? &area->nodes[binding.node - 1] : NULL;
    car->ai_input_callback = binding.suspended ? NULL : CarPlayerInput;
    car->ai_saved_input_callback = binding.suspended ? CarPlayerInput : NULL;
    return 1;
}

const SnapshotType WebSnapshotCarTypes[] = {
    { "car", sizeof(Car), car_fields, car_valid, capture_driver, restore_driver,
        .needs_template = 1 },
    { 0 },
};
