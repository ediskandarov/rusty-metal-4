#include "net_state_fields.h"
#include "snapshot.h"
#include "snapshot_types.h"
#include "src/modules/anim/private.h"
#include "src/modules/carprt/private.h"
#include "src/modules/frag/private.h"
#include "src/modules/levels/w_yard/private.h"
#include "src/modules/lightn/private.h"
#include "src/modules/ray/private.h"
#include "src/modules/weap/private.h"
#include "tm4/modules/conveyer.h"

#include <string.h>

static const WeaponProjectileType* stock_projectile_type(const WeaponProjectile* projectile)
{
    for (s32 i = 0; i < WeapTypeCount; ++i) {
        const WeaponProjectileType* type = &WeapTypes[i];
        if (projectile->type == type && projectile->physics == type->physics
            && projectile->on_destroy == type->on_destroy)
            return type;
    }
    return NULL;
}

static u32 polygon_index(const Tm4CollisionPolygon* polygon)
{
    uintptr_t base = (uintptr_t)WorldCollisionPolygons;
    uintptr_t offset = (uintptr_t)polygon - base;
    if (!polygon)
        return 0;
    if (offset % sizeof(*polygon) || offset / sizeof(*polygon) >= (u32)WebNetWorldPolygonCount())
        return UINT32_MAX;
    return offset / sizeof(*polygon) + 1;
}

static void history(NetStateOutput* hash, const Tm4InteractionNode* node)
{
    for (; node; node = node->next) {
        VALUE(1);
        VALUE(handle(node->payload));
        VALUE(node->stamp);
    }
    VALUE(0);
}

static void bullet_state(NetStateOutput* hash, const Bullet* bullet)
{
    key(hash, bullet->owner_name);
    key(hash, bullet->weapon_name);
    XYZ(bullet->previous_world);
    XYZ(bullet->current_world);
    XYZ(bullet->motion.vector);
    VALUE(bullet->motion.fields.world_impact);
    VALUE(bullet->motion.fields.collide_world);
    VALUE(handle(bullet->hit_object));
    if (bullet->hit_object) {
        XYZ(bullet->impact.fields.world_position);
        VALUE(bullet->impact.fields.damage);
    }
    if (bullet->motion.fields.world_impact) {
        XYZ(bullet->collision.position);
        XYZ(bullet->collision.surface.fields.normal);
        VALUE(bullet->collision.surface.fields.material);
        VALUE(handle(bullet->collision.owner));
        VALUE(polygon_index(bullet->collision.polygon));
    }
}

static int described_state(NetStateOutput* hash, const SnapshotType* type, const void* payload)
{
    /* Owned arrays can grow beyond a small fixed stack buffer. Use the same
     * capacity as portable snapshots so canonical hashing accepts their state. */
    static u8 bytes[WebSnapshotMaxBytes];
    const u32 length = WebSnapshotFieldsCapture(type, payload, bytes, sizeof(bytes));
    if (!length)
        return 0;
    for (u32 i = 0; i < length; ++i)
        state_byte(hash, bytes[i]);
    return 1;
}

static void emitter_state(NetStateOutput* hash, const SoundEmitter* emitter)
{
    VALUE(emitter->flags);
    XYZ(emitter->previous_position);
    XYZ(emitter->position);
    XYZ(emitter->velocity);
    VALUE(emitter->age_frames);
    VALUE(emitter->program_id);
    VALUE(emitter->voice_count);
    for (s32 i = 0; i < emitter->voice_count; ++i) {
        const SoundEmitterVoice* voice = &emitter->voices[i];
        VALUE(voice->attribute_index);
        VALUE(voice->duration_frames);
        VALUE(voice->pitch);
        VALUE(voice->volume);
        VALUE(voice->fade_per_frame);
    }
}

static void header_state(NetStateOutput* hash, const Tm4ObjectHeader* object)
{
    key(hash, object->name);
    VALUE(object->serial);
    VALUE(object->flags);
    VALUE(object->interaction_enabled);
    VALUE(object->is_interaction_extender);
    VALUE(object->interaction_radius);
    XYZ(object->position);
    VALUE(handle(object->owner));
}

int WebNetWriteObject(NetStateOutput* hash, const Tm4ObjectHeader* object, int inspect_payload)
{
    header_state(hash, object);
    if (!inspect_payload)
        return 1;
    const char* name = object->name;
    const void* payload = ObjectGetPayload(object);
    const SnapshotType* description = WebSnapshotObjectType(object);
    if (description && description->hash_fields)
        return described_state(hash, description, payload);
    if (!strcmp(name, "car")) {
        return 1;
    } else if (!strcmp(name, "carJump")) {
        const CarJump* jump = payload;
        VALUE(handle(jump->car));
        XYZ(jump->world_position);
        XYZ(jump->frame_displacement);
        VALUE(jump->frames_left);
    } else if (!strcmp(name, "camera")) {
        const Camera* camera = payload;
        VALUE(handle(camera->object));
    } else if (!strcmp(name, "soundEmitter")) {
        emitter_state(hash, payload);
    } else if (!strcmp(name, "bullet")) {
        bullet_state(hash, payload);
    } else if (!strcmp(name, "weaponProjectile")) {
        const WeaponProjectile* projectile = payload;
        const WeaponProjectileType* type = stock_projectile_type(projectile);
        if (!type)
            return 0;
        bullet_state(hash, &projectile->bullet);
        key(hash, type->name);
        VALUE(handle(projectile->owner));
        VALUE(handle(projectile->target));
        VALUE(handle(projectile->light));
        VALUE(projectile->damage);
        VALUE(projectile->interaction_radius);
        VALUE(projectile->homing_strength);
        VALUE(projectile->expiry_frames_left);
        VALUE(projectile->secondary_delay_seconds_q12);
        VALUE(projectile->age_frames);
        VALUE(projectile->seek_random);
        VALUE(projectile->seek_always);
        VALUE(projectile->trail_color_step.channels.mode);
        if (projectile->trail_color_step.channels.mode == WEAPON_TRAIL_RIBBON) {
            VALUE(projectile->trail_sample_index);
            VALUE(projectile->trail_sample_count);
            VALUE(projectile->trail_period_frames);
        }
        if (projectile->light) {
            VALUE(projectile->light_intensity);
            VALUE(projectile->light_intensity_step);
        }
        matrix(hash, &projectile->model_to_world);
    } else if (!strcmp(name, "weaponLightningEmitter")) {
        const LightningEmitter* emitter = payload;
        key(hash, emitter->type->name);
        VALUE(emitter->elapsed_frames);
        VALUE(emitter->bolt_count);
        for (unsigned i = 0; i < ArrayCount(emitter->bolts); ++i)
            VALUE(handle(emitter->bolts[i]));
    } else if (!strcmp(name, "weaponLightning")) {
        const Lightning* bolt = payload;
        key(hash, bolt->type->name);
        VALUE(handle(bolt->target));
        VALUE(bolt->damage);
        VALUE(bolt->rotation_tick);
        VALUE(bolt->point_count);
        XYZ(bolt->start);
        XYZ(bolt->end);
    } else if (!strcmp(name, "weaponBomb")) {
        const WeaponBomb* bomb = payload;
        key(hash, bomb->type->name);
        matrix(hash, &bomb->transform);
        VALUE(handle(bomb->flare));
        VALUE(bomb->age_ticks);
        VALUE(bomb->health);
    } else if (!strcmp(name, "weaponRayBeam")) {
        const RayBeam* beam = payload;
        key(hash, beam->type->name);
        matrix(hash, &beam->placement);
        matrix(hash, &beam->beam_to_world);
        VALUE(beam->damage);
        VALUE(beam->duration_frames);
        VALUE(beam->length);
        VALUE(beam->growth_per_frame);
        VALUE(beam->attachment_kind);
        VALUE(beam->maximum_length);
        VALUE(beam->age_frames);
        VALUE(polygon_index(beam->last_polygon));
        if (beam->last_polygon)
            XYZ(beam->hit_world);
    } else if (!strcmp(name, "anim")) {
        const Anim* anim = payload;
        key(hash, anim->type->name);
        key(hash, anim->sound);
        XYZ(anim->frame_displacement);
        VALUE(anim->age_frames);
        VALUE(anim->duration_frames);
        VALUE(anim->type->part_count);
        for (unsigned i = 0; i < anim->type->part_count; ++i) {
            VALUE(anim->parts[i].texture_elapsed_frames);
            VALUE(anim->parts[i].texture_frame);
            VALUE(anim->parts[i].width);
            VALUE(anim->parts[i].height);
            VALUE(anim->parts[i].width_step);
            VALUE(anim->parts[i].height_step);
            VALUE(anim->parts[i].billboard_offset.fields.texture_period_frames);
        }
    } else if (!strcmp(name, "powerup")) {
        const PowerupState* powerup = payload;
        key(hash, powerup->name);
        VALUE(powerup->units);
        VALUE(powerup->inactive_ticks);
        VALUE(powerup->respawn_delay_ticks);
        VALUE(powerup->base_height);
        VALUE(powerup->bob_phase_angle);
        XYZ(powerup->position.vector);
        VALUE(powerup->position.fields.regeneration_seconds);
        VALUE(powerup->position.fields.active);
    } else if (!strcmp(name, "fragment")) {
        const Fragment* fragment = payload;
        XYZ(fragment->collision_origin);
        XYZ(fragment->world_position_q12);
        XYZ(fragment->frame_displacement_q12);
        VALUE(fragment->gravity_step_q12);
        VALUE(fragment->collision_countdown);
        VALUE(fragment->radius);
        rotation(hash, &fragment->rotation_step);
        matrix(hash, &fragment->local_to_world);
    } else if (!strcmp(name, "carpart")) {
        const Carpart* part = payload;
        XYZ(part->collision_origin);
        XYZ(part->world_position_q12);
        XYZ(part->frame_displacement_q12);
        VALUE(part->gravity_step_q12);
        VALUE(part->collision_countdown);
        rotation(hash, &part->rotation_step);
        matrix(hash, &part->local_to_world);
    } else if (!strcmp(name, "explosionShockWave")) {
        const ExplosionWave* wave = payload;
        key(hash, wave->definition->name);
        VALUE(wave->height);
        VALUE(wave->color.packed);
        VALUE(wave->damage);
        VALUE(wave->duration_frames);
        VALUE(wave->inner_radial_speed);
        VALUE(wave->outer_radial_speed);
        VALUE(wave->drag_q12);
        VALUE(wave->inner_radius);
        VALUE(wave->outer_radius);
        VALUE(wave->hit_once);
        VALUE(wave->elapsed_frames);
        VALUE(wave->force);
        XYZ(wave->motion.vector);
        VALUE(wave->motion.fields.affects_owner);
        history(hash, wave->interactions);
    } else if (!strcmp(name, "interaction extender")) {
        const Tm4InteractionExtender* extender = payload;
        VALUE(extender->dx);
        VALUE(extender->dz);
        VALUE(handle(extender->next));
        for (const Tm4ExtenderSeen* seen = extender->seen; seen; seen = seen->next)
            VALUE(seen->object->serial + 1u);
        VALUE(0);
    } else if (!strcmp(name, "jumppad")) {
        const Jumppad* pad = payload;
        XYZ(pad->direction);
        VALUE(pad->acceleration);
        VALUE(pad->one_way);
        history(hash, pad->interaction_list);
    } else if (!strcmp(name, "conveyer")) {
        const Conveyer* conveyer = payload;
        VALUE(conveyer->speed);
    } else if (!strcmp(name, "teleporter")) {
        const Teleporter* teleporter = payload;
        XYZ(teleporter->destination_world);
        XYZ(teleporter->destination_forward_world);
    } else if (!strcmp(name, "destroyable")) {
        const Destroyable* destroyable = payload;
        VALUE(destroyable->hit_points);
        key(hash, RegGetDirectoryNameP(destroyable->registry));
        history(hash, destroyable->interactions);
    } else if (!strcmp(name, "crane")) {
        const Crane* crane = payload;
        matrix(hash, &crane->transform);
        VALUE(crane->rotation_angle);
        XYZ(crane->pivot);
        if (crane->control->operator_car) {
            XYZ(crane->magnet_position);
            VALUE(crane->ground_y);
        }
        VALUE(crane->miss_effect_ticks);
        VALUE(handle(crane->held_car));
        VALUE(handle(crane->control));
        VALUE(handle(crane->rotation_sound));
        VALUE(handle(crane->magnet_sound));
    } else if (!strcmp(name, "craneControl")) {
        const CraneControl* control = payload;
        VALUE(handle(control->crane));
        VALUE(handle(control->operator_car));
        if (control->operator_car)
            VALUE(control->saved_health);
        history(hash, control->interactions);
    } else if (!strcmp(name, "deathPoint")) {
        const DeathPoint* point = payload;
        history(hash, point->interactions);
    } else if (strcmp(name, "afc") && strcmp(name, "lightEmitter")) {
        return 0;
    }
    return 1;
}
