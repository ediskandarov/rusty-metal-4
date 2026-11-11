#include "snapshot_types.h"

#include "checkpoint.h"
#include "snapshot_world.h"
#include "src/modules/weap/private.h"

#include <string.h>

extern char BulletWeaponName[];

static const SnapshotField hit_fields[] = {
    SNAP_POD(Tm4WorldHit, position),
    SNAP_POD(Tm4WorldHit, surface),
    SNAP_REF(Tm4WorldHit, owner, NULL),
    SNAP_INDEX(Tm4WorldHit, polygon, &WebSnapshotCollisionPolygons),
    { 0 },
};

static int bullet_hit_world(const void* payload)
{
    return ((const Bullet*)payload)->motion.fields.world_impact != 0;
}

static const SnapshotGroupFields hit = { hit_fields, bullet_hit_world };

static const SnapshotField bullet_fields[] = {
    SNAP_STRING(Bullet, owner_name),
    SNAP_DERIVED(Bullet, weapon_name),
    SNAP_POD(Bullet, previous_world.vx),
    SNAP_POD(Bullet, previous_world.vy),
    SNAP_POD(Bullet, previous_world.vz),
    SNAP_TRANSIENT(Bullet, previous_world.pad),
    SNAP_POD(Bullet, current_world.vx),
    SNAP_POD(Bullet, current_world.vy),
    SNAP_POD(Bullet, current_world.vz),
    SNAP_TRANSIENT(Bullet, current_world.pad),
    SNAP_POD(Bullet, motion),
    SNAP_GROUP(Bullet, collision, &hit),
    SNAP_REF(Bullet, hit_object, NULL),
    SNAP_POD(Bullet, impact),
    { 0 },
};

static int bullet_motion_valid(const Bullet* bullet)
{
    return bullet->motion.fields.world_impact <= 1 && bullet->motion.fields.collide_world <= 1;
}

static int bullet_valid(const void* payload)
{
    const Bullet* bullet = payload;
    return bullet->weapon_name == BulletWeaponName && bullet_motion_valid(bullet);
}

static int restore_bullet_type(
    void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    if (length)
        return 0;
    ((Bullet*)payload)->weapon_name = BulletWeaponName;
    return 1;
}

static void* find_projectile(char* key)
{
    const s32 index = WeaponFindProjectileType(key);
    return index < 0 ? NULL : &WeapTypes[index];
}

static const SnapshotKeyBinding projectile_keys = {
    offsetof(WeaponProjectileType, name),
    find_projectile,
};

static const SnapshotGroupFields bullet_part = { bullet_fields, NULL };

static int projectile_ribbon(const void* payload)
{
    const WeaponProjectile* projectile = payload;
    return projectile->trail_color_step.channels.mode == WEAPON_TRAIL_RIBBON;
}

typedef WeaponTrailPoint Ribbon[4][WEAPON_TRAIL_SAMPLE_CAPACITY];
static const SnapshotField ribbon_fields[] = {
    { SnapshotPod, 0, sizeof(Ribbon), NULL },
    { 0 },
};
static const SnapshotGroupFields ribbon = { ribbon_fields, projectile_ribbon };

static const SnapshotField projectile_fields[] = {
    SNAP_GROUP(WeaponProjectile, bullet, &bullet_part),
    SNAP_POD(WeaponProjectile, damage),
    SNAP_POD(WeaponProjectile, interaction_radius),
    SNAP_POD(WeaponProjectile, homing_strength),
    SNAP_POD(WeaponProjectile, expiry_frames_left),
    SNAP_POD(WeaponProjectile, secondary_delay_seconds_q12),
    SNAP_POD(WeaponProjectile, model_to_world.m),
    SNAP_POD(WeaponProjectile, model_to_world.t),
    SNAP_POD(WeaponProjectile, age_frames),
    SNAP_WEAK_REF(WeaponProjectile, owner, NULL),
    SNAP_WEAK_REF(WeaponProjectile, target, "car"),
    SNAP_KEY(WeaponProjectile, type, &projectile_keys),
    SNAP_DERIVED(WeaponProjectile, physics),
    SNAP_DERIVED(WeaponProjectile, display),
    SNAP_DERIVED(WeaponProjectile, on_destroy),
    SNAP_POD(WeaponProjectile, trail_color_step),
    SNAP_GROUP(WeaponProjectile, trail_world, &ribbon),
    SNAP_POD(WeaponProjectile, trail_sample_index),
    SNAP_POD(WeaponProjectile, trail_width),
    SNAP_POD(WeaponProjectile, trail_sample_count),
    SNAP_POD(WeaponProjectile, trail_period_frames),
    SNAP_TRANSIENT(WeaponProjectile, unknown156),
    SNAP_POD(WeaponProjectile, seek_random),
    SNAP_POD(WeaponProjectile, seek_always),
    SNAP_POD(WeaponProjectile, shadow_length),
    SNAP_POD(WeaponProjectile, shadow_width),
    SNAP_REF(WeaponProjectile, light, "afc"),
    SNAP_POD(WeaponProjectile, light_intensity),
    SNAP_POD(WeaponProjectile, light_intensity_step),
    { 0 },
};

static int projectile_valid(const void* payload)
{
    const WeaponProjectile* projectile = payload;
    const WeaponProjectileType* type = projectile->type;
    int registered = 0;
    for (s32 i = 0; i < WeapTypeCount; ++i)
        if (type == &WeapTypes[i])
            registered = 1;
    return registered && projectile->physics == type->physics
        && projectile->on_destroy == type->on_destroy && projectile->display == type->display
        && projectile->bullet.weapon_name && !strcmp(projectile->bullet.weapon_name, type->name)
        && bullet_motion_valid(&projectile->bullet) && projectile->seek_always <= 1
        && projectile->trail_color_step.channels.mode <= WEAPON_TRAIL_ROLLING_EXPLOSION
        && (!projectile_ribbon(payload)
            || (projectile->trail_sample_count
                && projectile->trail_sample_count <= WEAPON_TRAIL_SAMPLE_CAPACITY
                && projectile->trail_sample_index >= 0
                && projectile->trail_sample_index < projectile->trail_sample_count
                && projectile->trail_period_frames
                && projectile->trail_period_frames <= WEAPON_TRAIL_MAX_PERIOD_FRAMES));
}

static int restore_projectile_type(
    void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    WeaponProjectile* projectile = payload;
    WeaponProjectileType* type = projectile->type;
    if (length || !type)
        return 0;
    projectile->physics = type->physics;
    projectile->display = type->display;
    projectile->on_destroy = type->on_destroy;
    projectile->bullet.weapon_name = type->name;
    if (type->tail_local_z != (u16)type->local_minimum.vz) {
        WebCheckpointWorldWrite(&type->tail_local_z, sizeof(type->tail_local_z));
        type->tail_local_z = type->local_minimum.vz;
    }
    return 1;
}

const SnapshotType WebSnapshotProjectileTypes[] = {
    { "bullet", sizeof(Bullet), bullet_fields, bullet_valid, NULL, restore_bullet_type },
    { "weaponProjectile", sizeof(WeaponProjectile), projectile_fields, projectile_valid, NULL,
        restore_projectile_type },
    { 0 },
};
