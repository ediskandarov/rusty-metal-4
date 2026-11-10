#include "snapshot_types.h"

#include "snapshot_world.h"

#include "src/modules/afc/private.h"
#include "src/modules/anim/private.h"
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
        if (!image || part->texture_frame < 0 || part->texture_frame >= image->count
            || !part->billboard_offset.fields.texture_period_frames)
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
    SNAP_REF(Lightning, target, "car"),
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

enum TimerKind { TimerDestroyObject = 1, TimerNextMode, TimerContinueMatch };

typedef struct {
    u32 kind, argument;
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
    TimerBinding binding;
    if (capacity < sizeof(binding))
        return 0;
    if (timer->callback == (TimerCallback)ObjectDestroy && timer->argument_count == 1) {
        binding.kind = TimerDestroyObject;
        binding.argument = WebSnapshotLiveHandle((void*)timer->arguments[0]);
        if (!binding.argument || binding.argument == UINT32_MAX)
            return 0;
    } else if (timer->callback == (TimerCallback)GameSetNextMode && timer->argument_count == 1) {
        binding.kind = TimerNextMode;
        binding.argument = timer->arguments[0];
    } else if (timer->callback == (TimerCallback)GameSetDeferredValue && timer->argument_count == 2
        && timer->arguments[0] == (uintptr_t)&GameInfo.deathmatch_accept_input) {
        binding.kind = TimerContinueMatch;
        binding.argument = timer->arguments[1];
    } else {
        return 0;
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
    timer->argument_count = 1;
    if (binding.kind == TimerDestroyObject) {
        void* target = binding.argument ? find(binding.argument) : NULL;
        if (!target)
            return 0;
        timer->callback = (TimerCallback)ObjectDestroy;
        timer->arguments[0] = (uintptr_t)target;
    } else if (binding.kind == TimerNextMode) {
        if (binding.argument > GAME_MODE_MENU)
            return 0;
        timer->callback = (TimerCallback)GameSetNextMode;
        timer->arguments[0] = binding.argument;
    } else if (binding.kind == TimerContinueMatch) {
        if (binding.argument > 1)
            return 0;
        timer->callback = (TimerCallback)GameSetDeferredValue;
        timer->argument_count = 2;
        timer->arguments[0] = (uintptr_t)&GameInfo.deathmatch_accept_input;
        timer->arguments[1] = binding.argument;
    } else {
        return 0;
    }
    return 1;
}

const SnapshotType WebSnapshotEffectTypes[] = {
    { "anim", sizeof(Anim), anim_fields, anim_valid, capture_anim_sound, restore_anim_sound },
    { "afc", sizeof(Afc), flare_fields, flare_valid, NULL, restore_flare_quad,
        .baseline_removable = 1, .alternate_process = WebAfcAdvanceFlareRotation },
    { "lightEmitter", sizeof(LightEmitter), light_fields, .baseline_removable = 1 },
    { "weaponBomb", sizeof(WeaponBomb), bomb_fields, bomb_valid, .baseline_removable = 1 },
    { "weaponRayBeam", sizeof(RayBeam), ray_fields, ray_valid, NULL, restore_ray_animation,
        .baseline_removable = 1 },
    { "weaponLightningEmitter", sizeof(LightningEmitter), lightning_emitter_fields,
        lightning_emitter_valid },
    { "weaponLightning", sizeof(Lightning), lightning_fields, lightning_valid },
    { "timer", sizeof(Timer), timer_fields, NULL, capture_timer_binding, restore_timer_binding },
    { 0 },
};
