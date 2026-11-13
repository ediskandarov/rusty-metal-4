#include "snapshot_types.h"

#include "snapshot_world.h"

#include "src/modules/afc/private.h"
#include "src/modules/anim/private.h"
#include "src/modules/car/private.h"
#include "src/modules/expl/private.h"
#include "src/modules/fire/private.h"
#include "src/modules/firing/private.h"
#include "src/modules/lightn/private.h"
#include "src/modules/ray/private.h"
#include "src/modules/timer/private.h"
#include "src/modules/weap/private.h"
#include "tm4/modules/light.h"

#include <stdint.h>
#include <string.h>

LightningClass* LightningFindClass(char* name);
void WebAfcAdvanceFlareRotation(void* payload);

static void* find_anim(char* key) { return AnimFindClass(key); }

static const SnapshotKeyBinding anim_keys = { offsetof(AnimClass, name), find_anim };

static u32 anim_parts(const void* payload)
{
    const Anim* anim = payload;
    return anim->type ? anim->type->part_count : 0;
}

static const SnapshotField anim_part_fields[] = {
    SNAP_POD(AnimPart, texture_elapsed_frames),
    SNAP_POD(AnimPart, texture_frame),
    SNAP_POD(AnimPart, width),
    SNAP_POD(AnimPart, height),
    SNAP_POD(AnimPart, width_step),
    SNAP_POD(AnimPart, height_step),
    SNAP_POD(AnimPart, billboard_offset),
    { 0 },
};

static const SnapshotArray anim_part_array = {
    anim_part_fields,
    sizeof(AnimPart),
    anim_parts,
    32,
};

static const SnapshotField anim_fields[] = {
    SNAP_POD(Anim, frame_displacement),
    SNAP_POD(Anim, age_frames),
    SNAP_KEY(Anim, type, &anim_keys),
    SNAP_OWNED_ARRAY(Anim, parts, &anim_part_array),
    SNAP_POD(Anim, duration_frames),
    SNAP_DERIVED(Anim, sound),
    { 0 },
};

static int anim_valid(const void* payload)
{
    const Anim* anim = payload;
    if (!anim->type || !anim->parts || !anim->type->part_count
        || (anim->sound && anim->sound != anim->type->sound))
        return 0;
    for (u32 i = 0; i < anim->type->part_count; ++i) {
        const AnimPart* part = &anim->parts[i];
        const AnimInfo* image = anim->type->parts[i].animation;
        if (!image || part->texture_frame < 0
            || !part->billboard_offset.fields.texture_period_frames)
            return 0;
        if (part->texture_elapsed_frames == ANIM_TEXTURE_FINISHED) {
            if (anim->duration_frames || part->texture_frame != image->count)
                return 0;
        } else if (part->texture_frame >= image->count)
            return 0;
    }
    return 1;
}

static u32 capture_anim_sound(const void* payload, u8* output, u32 capacity)
{
    if (!capacity)
        return 0;
    *output = ((const Anim*)payload)->sound != NULL;
    return 1;
}

static int restore_anim_sound(
    void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    Anim* anim = payload;
    if (length != 1 || *input > 1 || (*input && (!anim->type || !anim->type->sound)))
        return 0;
    anim->sound = *input ? anim->type->sound : NULL;
    return 1;
}

static u32 fire_ring_particles(const void* payload)
{
    return ((const FireRing*)payload)->particle_count;
}

static const SnapshotField fire_ring_particle_fields[] = {
    SNAP_REF(FireRingParticle, animation, "anim"),
    SNAP_POD(FireRingParticle, position),
    SNAP_POD(FireRingParticle, position_q12),
    SNAP_POD(FireRingParticle, step_q12),
    { 0 },
};

static const SnapshotArray fire_ring_particle_array = {
    fire_ring_particle_fields,
    sizeof(FireRingParticle),
    fire_ring_particles,
    UINT16_MAX,
};

static const SnapshotField fire_ring_fields[] = {
    SNAP_STRING(FireRing, animation_name),
    SNAP_POD(FireRing, origin_q12),
    SNAP_INDEX(FireRing, polygon, &WebSnapshotCollisionPolygons),
    SNAP_POD(FireRing, axis),
    SNAP_POD(FireRing, radius),
    SNAP_POD(FireRing, angular_divisions),
    SNAP_POD(FireRing, radius_step_per_frame),
    SNAP_POD(FireRing, split_spacing),
    SNAP_POD(FireRing, maximum_radius),
    SNAP_POD(FireRing, particle_count),
    SNAP_OWNED_ARRAY(FireRing, particles, &fire_ring_particle_array),
    { 0 },
};

static int fire_ring_valid(const void* payload)
{
    const FireRing* ring = payload;
    if (!ring->animation_name || !AnimFindClass(ring->animation_name) || !ring->particles
        || ring->particle_count <= 0 || ring->particle_count > UINT16_MAX
        || ring->angular_divisions < ring->particle_count)
        return 0;
    for (s32 i = 0; i < ring->particle_count; ++i) {
        const Anim* animation = ring->particles[i].animation;
        if (animation
            && (ObjectGetHeader(animation)->owner != ring
                || !(ObjectGetHeader(animation)->flags & OBJECT_DESTROY_WITH_OWNER)))
            return 0;
    }
    return 1;
}

static const SnapshotField flare_fields[] = {
    SNAP_POD(Afc, size),
    SNAP_POD(Afc, base_size),
    SNAP_POD(Afc, rotation_angle),
    SNAP_POD(Afc, rotation_step),
    SNAP_POD(Afc, color),
    SNAP_POD(Afc, base_color),
    SNAP_DERIVED(Afc, vertices),
    { 0 },
};

static int flare_valid(const void* payload)
{
    const Afc* flare = payload;
    return flare->size >= 0 && flare->base_size > 0;
}

static int restore_flare_quad(
    void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    if (length || !flare_valid(payload))
        return 0;
    AfcSetQuadSize(payload);
    return 1;
}

static const SnapshotField light_fields[] = {
    SNAP_POD(LightEmitter, flags),
    SNAP_POD(LightEmitter, color),
    SNAP_POD(LightEmitter, intensity_q12),
    SNAP_POD(LightEmitter, previous_world_position),
    SNAP_POD(LightEmitter, world_position),
    SNAP_POD(LightEmitter, direction_world),
    { 0 },
};

static void* find_bomb(char* key) { return WeaponFindBombType(key); }

static const SnapshotKeyBinding bomb_keys = { offsetof(WeaponBombType, name), find_bomb };

static const SnapshotField bomb_fields[] = {
    SNAP_KEY(WeaponBomb, type, &bomb_keys),
    SNAP_POD(WeaponBomb, transform),
    SNAP_REF(WeaponBomb, flare, "afc"),
    SNAP_POD(WeaponBomb, age_ticks),
    SNAP_POD(WeaponBomb, health),
    { 0 },
};

static int bomb_valid(const void* payload) { return ((const WeaponBomb*)payload)->type != NULL; }

static const SnapshotField target_fields[] = {
    SNAP_DERIVED(WeaponTarget, geometry),
    SNAP_POD(WeaponTarget, transform.m),
    SNAP_POD(WeaponTarget, transform.t),
    SNAP_TRANSIENT(WeaponTarget, unknown24),
    { 0 },
};

static int target_valid(const void* payload)
{
    const WeaponTarget* target = payload;
    return target->geometry && target->geometry == WeapTargetGeometry;
}

static int restore_target_geometry(
    void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    if (length)
        return 0;
    ((WeaponTarget*)payload)->geometry = WeapTargetGeometry;
    return 1;
}

static void* find_ray(char* key) { return RayFindClass(key); }

static const SnapshotKeyBinding ray_keys = { offsetof(RayClass, name), find_ray };

static const SnapshotField ray_fields[] = {
    SNAP_POD(RayBeam, placement),
    SNAP_POD(RayBeam, beam_to_world),
    SNAP_POD(RayBeam, damage),
    SNAP_POD(RayBeam, duration_frames),
    SNAP_POD(RayBeam, length),
    SNAP_POD(RayBeam, growth_per_frame),
    SNAP_POD(RayBeam, attachment_kind),
    SNAP_POD(RayBeam, maximum_length),
    SNAP_POD(RayBeam, age_frames),
    SNAP_INDEX(RayBeam, last_polygon, &WebSnapshotCollisionPolygons),
    SNAP_KEY(RayBeam, type, &ray_keys),
    SNAP_DERIVED(RayBeam, animation),
    SNAP_POD(RayBeam, animation_frame),
    SNAP_POD(RayBeam, has_animation),
    SNAP_POD(RayBeam, hit_world),
    { 0 },
};

static int ray_valid(const void* payload)
{
    const RayBeam* ray = payload;
    return ray->type && ray->attachment_kind <= RAY_ATTACHMENT_PROJECTILE && ray->has_animation <= 1
        && (!ray->has_animation
            || (ray->animation && ray->animation_frame < ray->animation->count));
}

static int restore_ray_animation(
    void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    RayBeam* ray = payload;
    if (length || !ray->type)
        return 0;
    ray->animation = ray->has_animation && ray->type->animation_name
        ? GetAnimInfo(ray->type->animation_name)
        : NULL;
    return 1;
}

static void* find_lightning(char* key) { return LightningFindClass(key); }

static const SnapshotKeyBinding lightning_keys = { offsetof(LightningClass, name), find_lightning };

static const SnapshotField lightning_emitter_fields[] = {
    SNAP_REF(LightningEmitter, bolts, "weaponLightning"),
    SNAP_POD(LightningEmitter, elapsed_frames),
    SNAP_KEY(LightningEmitter, type, &lightning_keys),
    SNAP_POD(LightningEmitter, bolt_count),
    SNAP_POD(LightningEmitter, angle),
    { 0 },
};

static int lightning_emitter_valid(const void* payload)
{
    const LightningEmitter* emitter = payload;
    return emitter->type && emitter->bolt_count <= LIGHTNING_BOLT_CAPACITY
        && emitter->bolt_count <= emitter->type->max_bolts;
}

static const SnapshotField lightning_fields[] = {
    SNAP_POD(Lightning, matrix),
    SNAP_WEAK_REF(Lightning, target, "car"),
    SNAP_POD(Lightning, start),
    SNAP_POD(Lightning, end),
    SNAP_POD(Lightning, point_count),
    SNAP_POD(Lightning, damage),
    SNAP_POD(Lightning, rotation_tick),
    SNAP_KEY(Lightning, type, &lightning_keys),
    SNAP_POD(Lightning, points),
    SNAP_TRANSIENT(Lightning, unknown_b8),
    { 0 },
};

static int lightning_valid(const void* payload)
{
    const Lightning* bolt = payload;
    return bolt->type && bolt->point_count <= LIGHTNING_POINT_CAPACITY;
}

static void* find_flame_animation(char* key)
{
    for (s32 i = 0; i < FlameClassCount; ++i) {
        char* name = FlameClasses[i].animation_name;
        if (name && !strcmp(name, key))
            return name;
    }
    return NULL;
}

static const SnapshotKeyBinding flame_animation = { .resolve = find_flame_animation };

static void* flame_weapon_base(const void* payload)
{
    const Car* owner = ObjectGetHeader(payload)->owner;
    return owner && ObjectValidObject((void*)owner) && !strcmp(ObjectGetHeader(owner)->name, "car")
        ? owner->weapons
        : NULL;
}

static u32 flame_weapon_count(const void* payload) { return CarWeaponCount; }

static const SnapshotIndexBinding flame_weapons = {
    flame_weapon_base,
    flame_weapon_count,
    sizeof(CarWeaponInstance),
};

static const SnapshotField flame_fields[] = {
    SNAP_POD(FlameEmitter, world_direction),
    SNAP_POD(FlameEmitter, world_velocity),
    SNAP_POD(FlameEmitter, period_frames),
    SNAP_POD(FlameEmitter, emit_period_frames),
    SNAP_POD(FlameEmitter, emit_elapsed_frames),
    SNAP_POD(FlameEmitter, jitter_range),
    SNAP_POD(FlameEmitter, phase_frames),
    SNAP_POD(FlameEmitter, periodic),
    SNAP_POD(FlameEmitter, active),
    SNAP_POD(FlameEmitter, launch_speed),
    SNAP_POD(FlameEmitter, launcher_index),
    SNAP_INDEX(FlameEmitter, weapon, &flame_weapons),
    SNAP_RESOURCE_STRING(FlameEmitter, animation_name, &flame_animation),
    { 0 },
};

static int flame_valid(const void* payload)
{
    const FlameEmitter* emitter = payload;
    if (!emitter->animation_name || !find_flame_animation(emitter->animation_name)
        || !emitter->period_frames || !emitter->emit_period_frames || !emitter->jitter_range
        || (u32)emitter->active > 1)
        return 0;
    if (!emitter->weapon)
        return 1;
    const void* base = flame_weapon_base(payload);
    const uintptr_t offset = (uintptr_t)emitter->weapon - (uintptr_t)base;
    return base && !(offset % sizeof(CarWeaponInstance))
        && offset / sizeof(CarWeaponInstance) < (u32)CarWeaponCount && emitter->weapon->launchers
        && emitter->weapon->count > 0 && (u32)emitter->launcher_index < (u32)emitter->weapon->count;
}

static void* find_wave(char* key) { return FindExplosionDefinition(key); }

static const SnapshotKeyBinding wave_keys = { offsetof(ExplosionDefinition, name), find_wave };

static u32 wave_points(const void* payload)
{
    const ExplosionWave* wave = payload;
    return wave->definition ? wave->definition->sides : 0;
}

static const SnapshotField wave_point_fields[] = {
    SNAP_POD(ExplosionPoint, cosine_q12),
    SNAP_POD(ExplosionPoint, sine_q12),
    { 0 },
};

static const SnapshotArray wave_point_array = {
    wave_point_fields,
    sizeof(ExplosionPoint),
    wave_points,
    EXPLOSION_MAX_SIDE_COUNT,
};

static const SnapshotField wave_fields[] = {
    SNAP_KEY(ExplosionWave, definition, &wave_keys),
    SNAP_OWNED_ARRAY(ExplosionWave, points, &wave_point_array),
    SNAP_POD(ExplosionWave, height),
    SNAP_POD(ExplosionWave, damage),
    SNAP_POD(ExplosionWave, color),
    SNAP_POD(ExplosionWave, duration_frames),
    SNAP_POD(ExplosionWave, inner_radial_speed),
    SNAP_POD(ExplosionWave, outer_radial_speed),
    SNAP_POD(ExplosionWave, drag_q12),
    SNAP_POD(ExplosionWave, inner_radius),
    SNAP_POD(ExplosionWave, outer_radius),
    SNAP_POD(ExplosionWave, hit_once),
    SNAP_POD(ExplosionWave, elapsed_frames),
    SNAP_POD(ExplosionWave, force),
    SNAP_LIST(ExplosionWave, interactions, &WebSnapshotInteractionHistory),
    SNAP_POD(ExplosionWave, motion),
    SNAP_TRANSIENT(ExplosionWave, ray_result),
    SNAP_DERIVED(ExplosionWave, sound),
    SNAP_DERIVED(ExplosionWave, texture),
    { 0 },
};

static int wave_valid(const void* payload)
{
    const ExplosionWave* wave = payload;
    return wave->definition && wave->points && wave->definition->sides >= EXPLOSION_MIN_SIDE_COUNT
        && wave->definition->sides <= EXPLOSION_MAX_SIDE_COUNT
        && wave->sound == wave->definition->sound && wave->texture == wave->definition->texture
        && wave->duration_frames > 0 && wave->elapsed_frames <= (u32)wave->duration_frames;
}

static int restore_wave_resources(
    void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    ExplosionWave* wave = payload;
    if (length || !wave->definition)
        return 0;
    wave->ray_result = NULL;
    wave->sound = wave->definition->sound;
    wave->texture = wave->definition->texture;
    return 1;
}

void WeaponSpawnImpactObject(s32 x, s32 y, s32 z, u32 low, u32 high);
void WeaponSpawnImpactEffects(s32 x, s32 y, s32 z, u32 low, u32 high);
void WeaponSpawnMovingExplosion(s32 x, s32 y, s32 z, s32 scale, s32 speed);

enum TimerKind {
    TimerDestroyObject,
    TimerNextMode,
    TimerContinueMatch,
    TimerImpactWave,
    TimerFunnyWave,
    TimerMovingExplosion,
};

static const struct {
    TimerCallback function;
    u32 count;
} timer_bindings[] = {
    [TimerDestroyObject] = { (TimerCallback)ObjectDestroy, 1 },
    [TimerNextMode] = { (TimerCallback)GameSetNextMode, 1 },
    [TimerContinueMatch] = { (TimerCallback)GameSetDeferredValue, 2 },
    [TimerImpactWave] = { (TimerCallback)WeaponSpawnImpactObject, 5 },
    [TimerFunnyWave] = { (TimerCallback)WeaponSpawnImpactEffects, 5 },
    [TimerMovingExplosion] = { (TimerCallback)WeaponSpawnMovingExplosion, 5 },
};

typedef struct {
    u32 kind, arguments[5];
} TimerBinding;

static const SnapshotField timer_fields[] = {
    SNAP_POD(Timer, remaining_ticks),
    SNAP_DERIVED(Timer, callback),
    SNAP_DERIVED(Timer, argument_count),
    SNAP_DERIVED(Timer, arguments),
    { 0 },
};

static u32 capture_timer_binding(const void* payload, u8* output, u32 capacity)
{
    const Timer* timer = payload;
    TimerBinding binding = { 0 };
    if (capacity < sizeof(binding))
        return 0;
    while (binding.kind < ArrayCount(timer_bindings)) {
        if (timer_bindings[binding.kind].function == timer->callback
            && timer_bindings[binding.kind].count == (u32)timer->argument_count)
            break;
        ++binding.kind;
    }
    if (binding.kind == ArrayCount(timer_bindings))
        return 0;

    memcpy(binding.arguments, timer->arguments, timer->argument_count * sizeof(u32));
    if (binding.kind == TimerDestroyObject) {
        binding.arguments[0] = WebSnapshotLiveHandle((void*)(uintptr_t)timer->arguments[0]);
        if (!binding.arguments[0] || binding.arguments[0] == UINT32_MAX)
            return 0;
    } else if (binding.kind == TimerContinueMatch) {
        if (timer->arguments[0] != (uintptr_t)&GameInfo.deathmatch_accept_input)
            return 0;
        binding.arguments[0] = 0;
    }
    memcpy(output, &binding, sizeof(binding));
    return sizeof(binding);
}

static int restore_timer_binding(
    void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    Timer* timer = payload;
    TimerBinding binding;
    if (length != sizeof(binding))
        return 0;
    memcpy(&binding, input, sizeof(binding));
    if (binding.kind >= ArrayCount(timer_bindings))
        return 0;
    switch (binding.kind) {
    case TimerDestroyObject: {
        void* target = binding.arguments[0] ? find(binding.arguments[0]) : NULL;
        if (!target)
            return 0;
        binding.arguments[0] = (uintptr_t)target;
        break;
    }
    case TimerNextMode:
        if (binding.arguments[0] > GAME_MODE_MENU)
            return 0;
        break;
    case TimerContinueMatch:
        if (binding.arguments[0] || binding.arguments[1] > 1)
            return 0;
        binding.arguments[0] = (uintptr_t)&GameInfo.deathmatch_accept_input;
        break;
    case TimerMovingExplosion:
        if (!binding.arguments[3] || binding.arguments[3] > 4096 || binding.arguments[4] > 32767)
            return 0;
        break;
    }
    timer->callback = timer_bindings[binding.kind].function;
    timer->argument_count = timer_bindings[binding.kind].count;
    memcpy(timer->arguments, binding.arguments, timer->argument_count * sizeof(u32));
    return 1;
}

const SnapshotType WebSnapshotEffectTypes[] = {
    { "fireRing", sizeof(FireRing), fire_ring_fields, fire_ring_valid, .hash_fields = 1 },
    { "anim", sizeof(Anim), anim_fields, anim_valid, capture_anim_sound, restore_anim_sound },
    { "afc", sizeof(Afc), flare_fields, flare_valid, NULL, restore_flare_quad,
        .baseline_removable = 1, .alternate_process = WebAfcAdvanceFlareRotation },
    { "lightEmitter", sizeof(LightEmitter), light_fields, .baseline_removable = 1 },
    { "weaponBomb", sizeof(WeaponBomb), bomb_fields, bomb_valid, .baseline_removable = 1 },
    { "weaponTarget", sizeof(WeaponTarget), target_fields, target_valid, NULL,
        restore_target_geometry, .hash_fields = 1 },
    { "weaponRayBeam", sizeof(RayBeam), ray_fields, ray_valid, NULL, restore_ray_animation,
        .baseline_removable = 1 },
    { "weaponLightningEmitter", sizeof(LightningEmitter), lightning_emitter_fields,
        lightning_emitter_valid },
    { "weaponLightning", sizeof(Lightning), lightning_fields, lightning_valid },
    { "flameEmitter", sizeof(FlameEmitter), flame_fields, flame_valid, .hash_fields = 1 },
    { "explosionShockWave", sizeof(ExplosionWave), wave_fields, wave_valid, NULL,
        restore_wave_resources },
    { "timer", sizeof(Timer), timer_fields, NULL, capture_timer_binding, restore_timer_binding,
        .baseline_removable = 1, .hash_fields = 1 },
    { 0 },
};
