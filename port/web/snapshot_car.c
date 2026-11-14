#include "snapshot_types.h"

#include "net_match.h"
#include "src/main/object/private.h"
#include "src/modules/car/private.h"
#include "src/modules/cars/c_crush/private.h"
#include "src/modules/cars/c_toy/private.h"
#include "src/modules/cars/shovel.h"
#include "tm4/main/game.h"
#include "tm4/main/memory.h"
#include "tm4/modules/auger.h"

#include <stdint.h>
#include <string.h>

s32 CarToyProcess(Car* car, void* state);
s32 CarPirateProcess(Car* car, void* state);
s32 CarTankProcess(Car* car, void* state);
void CarTankDestructor(Car* car, void* state);
s32 CarMinionProcess(Car* car, void* state);
void CarMinionDestructor(Car* car, void* state);
s32 CarTrashProcess(Car* car, void* state);
u32 InteractCarTrashWithCar(Car* car, void* state, Car* other);
s32 CarSlamProcess(Car* car, void* state);
u32 InteractCarSlamWithCar(Car* car, void* state, Car* other);
s32 CarCrusherProcess(Car* car, void* state);
void CarCrusherDestructor(Car* car, void* state);
u32 InteractCarCrusherWithCar(Car* car, void* state, Car* other);
void Web_cars_c_crush_TreadPolysProcess(Car* car);
s32 CarTankConstructor(Car*, void*);
s32 CarMinionConstructor(Car*, void*);
s32 CarCrusherConstructor(Car*, void*);
s32 WebAugerProcess(Car* car, void* state);

static const SnapshotField windup_fields[] = {
    SNAP_POD(ToyWindup, angle),
    { 0 },
};
static const SnapshotType windup = { "toyWindup", sizeof(ToyWindup), windup_fields };
/* The pirate allocates a word that none of its callbacks reads or writes. */
static const SnapshotType pirate = { "pirate", sizeof(s32) };
static const SnapshotType treads = { "treads" };
static const SnapshotField shovel_fields[] = {
    SNAP_POD(CarShovelState, angle),
    SNAP_POD(CarShovelState, angular_speed),
    SNAP_POD(CarShovelState, angular_acceleration),
    SNAP_POD(CarShovelState, target_transform.m),
    SNAP_POD(CarShovelState, target_transform.t),
    SNAP_POD(CarShovelState, has_caught_target),
    SNAP_POD(CarShovelState, remaining_slams),
    SNAP_WEAK_REF(CarShovelState, target, "car"),
    SNAP_REF(CarShovelState, loop_sound, "soundEmitter"),
    { 0 },
};

static const SnapshotType shovel = { "shovel", sizeof(CarShovelState), shovel_fields };
static const SnapshotField pinchers_fields[] = {
    SNAP_POD(CrusherPinchers, upper_angle),
    SNAP_POD(CrusherPinchers, lower_angle),
    SNAP_POD(CrusherPinchers, angular_speed),
    SNAP_POD(CrusherPinchers, angular_acceleration),
    SNAP_POD(CrusherPinchers, target_transform.m),
    SNAP_POD(CrusherPinchers, target_transform.t),
    SNAP_POD(CrusherPinchers, has_caught_target),
    SNAP_POD(CrusherPinchers, remaining_crushes),
    SNAP_WEAK_REF(CrusherPinchers, target, "car"),
    SNAP_REF(CrusherPinchers, loop_sound, "soundEmitter"),
    { 0 },
};
static const SnapshotType pinchers = { "pinchers", sizeof(CrusherPinchers), pinchers_fields };
static const SnapshotField drill_fields[] = {
    SNAP_POD(AugerDrill, angle),
    SNAP_POD(AugerDrill, angular_speed),
    SNAP_POD(AugerDrill, active_ticks),
    SNAP_WEAK_REF(AugerDrill, target, "car"),
    SNAP_REF(AugerDrill, loop_sound, "soundEmitter"),
    { 0 },
};
static const SnapshotType drill = { "drill", sizeof(AugerDrill), drill_fields };
static const SnapshotType no_callbacks = { "none" };

static s32 refresh_crusher_treads(Car* car, void* state)
{
    Web_cars_c_crush_TreadPolysProcess(car);
    return 1;
}

typedef struct {
    const SnapshotType* type;
    s32 (*process)(Car*, void*);
    CarCollisionCallback collision;
    void (*destroy)(Car*, void*);
    s32 (*refresh)(Car*, void*);
    s32 (*resources)(Car*, void*);
} CarCallbackBinding;

static const CarCallbackBinding callback_types[] = {
    { &no_callbacks },
    { &windup, CarToyProcess },
    { &pirate, CarPirateProcess },
    { &treads, CarTankProcess, .destroy = CarTankDestructor, .refresh = CarTankProcess,
        .resources = CarTankConstructor },
    { &treads, CarMinionProcess, .destroy = CarMinionDestructor, .refresh = CarMinionProcess,
        .resources = CarMinionConstructor },
    { &shovel, CarTrashProcess, InteractCarTrashWithCar },
    { &shovel, CarSlamProcess, InteractCarSlamWithCar },
    { &pinchers, CarCrusherProcess, InteractCarCrusherWithCar, CarCrusherDestructor,
        refresh_crusher_treads, CarCrusherConstructor },
    { &drill, WebAugerProcess, InteractCarAugerWithCar },
};

static const CarCallbackBinding* find_callbacks(const Car* car)
{
    for (u32 i = 0; i < ArrayCount(callback_types); ++i) {
        const CarCallbackBinding* binding = &callback_types[i];
        if (car->process_callback == binding->process
            && car->collision_callback == binding->collision
            && car->destructor_callback == binding->destroy
            && (car->callback_context != NULL) == (binding->type->size != 0))
            return binding;
    }
    return NULL;
}

const SnapshotType* WebSnapshotCarCallbackType(const Car* car)
{
    const CarCallbackBinding* binding = find_callbacks(car);
    return binding ? binding->type : NULL;
}

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
    .discard_on_target_destroy = 1,
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
    SNAP_WEAK_REF(CarAiRuntime, target, "car"),
    { 0 },
};
static const SnapshotGroupFields driver_location = { driver_location_fields, NULL };

typedef struct {
    char model[64];
    s32 entrant, slot;
} CarConstruction;

static int capture_construction(const void* payload, void* output)
{
    const Car* car = payload;
    CarConstruction* record = output;
    const size_t length = strlen(car->character_name);
    if (length >= sizeof(record->model))
        return 0;
    memcpy(record->model, car->character_name, length + 1);
    record->entrant = car->index;
    record->slot = car->controller_index;
    return 1;
}

static int restore_construction(void* payload, const void* input)
{
    Car* car = payload;
    const CarConstruction* record = input;
    if (!memchr(record->model, 0, sizeof(record->model)) || record->entrant < 0
        || record->entrant >= GameInfo.player_car_count
        || WebNetParticipantSlot(record->entrant) != record->slot
        || strcmp(record->model, GameInfo.character_names[record->entrant]))
        return 0;
    if (car->character_name)
        return car->index == record->entrant && car->controller_index == record->slot
            && !strcmp(car->character_name, record->model);
    SVECTOR position = { 0 }, heading = { .vz = ONE };
    if (!CarPrepareResources(car, (char*)record->model, record->entrant, record->slot,
            CAR_CONTROL_PLAYER, &position, &heading))
        return 0;
    const CarCallbackBinding* callbacks = find_callbacks(car);
    if (!callbacks)
        return 0;
    if (callbacks->resources && !callbacks->resources(car, car->callback_context)) {
        car->destructor_callback = NULL;
        return 0;
    }
    return 1;
}

static const SnapshotConstructionBinding construction
    = { sizeof(CarConstruction), capture_construction, restore_construction };

/* Removed templates are no longer in session roots. Do not detonate their devices
 * or unregister against the newly restored roster. */
static void release_car(void* payload)
{
    Car* car = payload;
    for (s32 i = 0; car->weapons && i < CarWeaponCount; ++i)
        car->weapons[i].active = 0;
    CarReleaseResources(car);
}

/* Bot steering, plans and target lists are inactive with CarPlayerInput. The
 * common navigation probe still runs for human cars when the map has AI data. */
static const SnapshotField car_fields[] = {
    { SnapshotConstruction, .binding = &construction },
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
    SNAP_DERIVED(Car, original_faces),
    SNAP_DERIVED(Car, original_colors),
    SNAP_POD(Car, invisibility_hidden),
    SNAP_POD(Car, turbo_emitter_count),
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
    SNAP_POD(Car, burn_source),
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
    SNAP_DERIVED(Car, callback_context),
    SNAP_LOCAL(Car, process_callback),
    SNAP_LOCAL(Car, collision_callback),
    SNAP_LOCAL(Car, destructor_callback),
    { 0 },
};

void CarInvisibilityConstructorProcess(Car** effect);
s32 CarCopyDisplayFaces(Car* car, u8 reflection);
s32 CarCopyDisplayColors(Car* car);
void CarRestoreOriginalFaces(Car* car);
void CarRestoreOriginalColors(Car* car);

static u32 display_face_count(const Car* car)
{
    u32 count = 0;
    for (s32 i = 0; i < car->display_list_count; ++i)
        count += car->display_lists[i].face_count;
    return count;
}

static int display_state_valid(const Car* car)
{
    return car->faces && car->colors && car->normal_count > 0 && car->normal_count <= UINT16_MAX
        && display_face_count(car) <= UINT16_MAX
        && (!car->original_faces || car->freeze_ticks || car->shield_ticks
            || car->invisibility_ticks)
        && (!car->original_colors || (car->original_faces && car->invisibility_ticks))
        && (car->invisibility_hidden == 0 || car->invisibility_hidden == 1);
}

static int turbo_resources_valid(const Car* car)
{
    if (!car->turbo_emitter_count)
        return !car->turbo_emitters;
    RegistryDirectory* models = RegGetDirectoryPtrPS(CarClassDirectory, CarTextCharacters);
    RegistryDirectory* model = RegGetDirectoryPtrPS(models, car->character_name);
    RegistryDirectory* emitters = RegGetDirectoryPtrPS(model, CarDisplayTurboName);
    return emitters && car->turbo_emitters
        && car->turbo_emitter_count == RegGetNumberOfDirectoriesP(emitters);
}

static int car_valid(const void* payload)
{
    const Car* car = payload;
    if (car->control_kind != CAR_CONTROL_PLAYER || !CarPhysicsResourcesValid(car) || !car->weapons
        || !car->character_name || !turbo_resources_valid(car)
        || !((car->ai_input_callback == CarPlayerInput && !car->ai_saved_input_callback)
            || (!car->ai_input_callback && car->ai_saved_input_callback == CarPlayerInput))
        || car->ai_state_callback != CarAiApproachTarget || car->ai_saved_state_callback
        || !WebSnapshotCarCallbackType(car) || car->active_collision_particle
        || car->active_collision_hit || !display_state_valid(car) || car->ai.target_entry
        || car->ai.nearby_list || car->ai.targeting_count || car->health <= 0
        || car->health > car->maximum_health || car->controls.gear < CAR_GEAR_REVERSE
        || car->controls.gear > CAR_GEAR_FOURTH || car->controls.action < CarActionNone
        || car->controls.action >= CarActionCount || car->controls.selected_weapon < 0
        || car->controls.selected_weapon >= CarWeaponCount || car->controls.selected_weapon_slot < 0
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
    u8 suspended, copied_faces, copied_colors;
} DriverBinding;

static u32 capture_driver(const void* payload, u8* output, u32 capacity)
{
    const Car* car = payload;
    if (capacity < sizeof(DriverBinding) || !car->ai.area)
        return 0;
    DriverBinding binding;
    memset(&binding, 0, sizeof(binding));
    binding.suspended = !car->ai_input_callback;
    binding.copied_faces = car->original_faces != NULL;
    binding.copied_colors = car->original_colors != NULL;
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
    const u32 faces = binding.copied_faces ? display_face_count(car) : 0;
    const u32 colors_bytes = binding.copied_colors ? car->normal_count * sizeof(CVECTOR) : 0;
    const u32 prefix = sizeof(binding) + faces + colors_bytes;
    if (prefix >= capacity)
        return 0;
    for (u32 i = 0; i < faces; ++i)
        output[sizeof(binding) + i] = car->faces[i].reflection;
    if (colors_bytes)
        memcpy(output + sizeof(binding) + faces, car->colors, colors_bytes);
    const SnapshotType* type = WebSnapshotCarCallbackType(car);
    const u32 length = type
        ? WebSnapshotFieldsCapture(type, car->callback_context, output + prefix, capacity - prefix)
        : 0;
    if (!length)
        return 0;
    memcpy(output, &binding, sizeof(binding));
    return prefix + length;
}

static int restore_driver(void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    Car* car = payload;
    DriverBinding binding;
    if (length <= sizeof(binding))
        return 0;
    memcpy(&binding, input, sizeof(binding));
    if (!binding.area || binding.area > ArrayCount(aiWorldInfo.areas) || binding.suspended > 1
        || binding.copied_faces > 1 || binding.copied_colors > 1)
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
    if (!car->turbo_emitter_count) {
        MemFree(car->turbo_emitters);
        car->turbo_emitters = NULL;
    }
    const u32 faces = binding.copied_faces ? display_face_count(car) : 0;
    const u32 colors_bytes = binding.copied_colors ? car->normal_count * sizeof(CVECTOR) : 0;
    const u32 prefix = sizeof(binding) + faces + colors_bytes;
    if (prefix >= length)
        return 0;
    const CarCallbackBinding* callbacks = find_callbacks(car);
    if (!callbacks
        || !WebSnapshotFieldsRestore(
            callbacks->type, car->callback_context, input + prefix, length - prefix, find)
        || (callbacks->refresh && !callbacks->refresh(car, car->callback_context)))
        return 0;

    /* Rebuild private display buffers without spawning a second fade object. */
    CarRestoreOriginalColors(car);
    CarRestoreOriginalFaces(car);
    if ((binding.copied_faces && !CarCopyDisplayFaces(car, 0))
        || (binding.copied_colors && !CarCopyDisplayColors(car)))
        return 0;
    for (u32 i = 0; i < faces; ++i)
        car->faces[i].reflection = input[sizeof(binding) + i];
    if (colors_bytes)
        memcpy(car->colors, input + sizeof(binding) + faces, colors_bytes);
    return 1;
}

typedef struct {
    Car* car;
} InvisibilityFade;

static const SnapshotCustomClass invisibility_class = {
    .process = (Tm4ObjectCallback)CarInvisibilityConstructorProcess,
};
static const SnapshotField invisibility_fields[] = {
    SNAP_REQUIRED(InvisibilityFade, car, "car"),
    { 0 },
};

const SnapshotType WebSnapshotCarTypes[] = {
    { "carInvisibilityConstructor", sizeof(InvisibilityFade), invisibility_fields,
        .baseline_removable = 1, .hash_fields = 1, .custom = &invisibility_class },
    { "car", sizeof(Car), car_fields, car_valid, capture_driver, restore_driver,
        .baseline_removable = 1, .release = release_car },
    { 0 },
};
