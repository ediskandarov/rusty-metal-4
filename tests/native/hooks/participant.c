#include "pending.h"
#include "port/web/carpart.h"
#include "port/web/checkpoint_memory.h"
#include "port/web/net_match.h"
#include "port/web/snapshot_types.h"
#include "src/main/object/private.h"
#include "src/modules/car/private.h"
#include "src/modules/cars/c_crush/private.h"
#include "src/modules/cars/shovel.h"
#include "src/modules/fire/private.h"
#include "src/modules/firing/private.h"
#include "src/modules/lightn/private.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"
#include "tm4/main/memory.h"
#include "tm4/main/object.h"
#include "tm4/main/sound.h"
#include "tm4/modules/anim.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/weap.h"
#include "tm4/vector.h"
#include <emscripten.h>
#include <stdint.h>
#include <string.h>

EMSCRIPTEN_KEEPALIVE unsigned WebTestNetworkSlotBindings(s32 slot)
{
    if (slot < 0 || slot >= ArrayCount(GameInfo.players))
        return 0;
    const Tm4GamePlayer* player = &GameInfo.players[slot];
    return !!player->camera | (!!player->car << 1)
        | ((player->car && player->car->controller_index == slot) << 2)
        | ((player->camera && player->car && player->camera->object == player->car) << 3);
}
/* Focused participant-lifetime fixtures schedule mutations at the existing tick boundary. */
static u32 participant_kill_slots;
static u32 participant_hit_projectiles[8];

EMSCRIPTEN_KEEPALIVE u32 WebTestCreateParticipantProjectile(s32 slot)
{
    if (!WebNetMatchActive() || !WebNetSlotOccupied(slot))
        return 0;
    Car* car = GameInfo.players[slot].car;
    if (!car)
        return 0;
    MATRIX launch = car->transform;
    launch.t[1] -= 512;
    SVECTOR velocity = { 0 };
    WebCheckpointArenaSelect(1);
    WeaponProjectile* projectile = ObjectCreate(CarTextWeaponProjectile,
        OBJECT_HAS_OWNER | OBJECT_SURVIVE_OWNER, car, CarTextPower, NULL, &launch, &velocity);
    if (projectile) {
        setVector(&projectile->bullet.motion.fields.world_velocity, 0, 0, 0);
        projectile->damage = 0xffff;
    }
    WebCheckpointArenaSelect(0);
    return projectile ? ObjectGetHeader(projectile)->serial + 1u : 0;
}

static Car** test_capture_target(Car* car)
{
    const SnapshotType* type = car ? WebSnapshotCarCallbackType(car) : NULL;
    if (!type || !car->callback_context)
        return NULL;
    if (!strcmp(type->name, "pinchers"))
        return &((CrusherPinchers*)car->callback_context)->target;
    if (!strcmp(type->name, "shovel"))
        return &((CarShovelState*)car->callback_context)->target;
    return NULL;
}

EMSCRIPTEN_KEEPALIVE int WebTestBindCaptureTarget(s32 captor, s32 target)
{
    if (!WebNetSlotOccupied(captor) || !WebNetSlotOccupied(target))
        return 0;
    Car** reference = test_capture_target(GameInfo.players[captor].car);
    if (!reference || !GameInfo.players[target].car)
        return 0;
    *reference = GameInfo.players[target].car;
    return 1;
}

EMSCRIPTEN_KEEPALIVE u32 WebTestCaptureTarget(s32 captor)
{
    Car** reference
        = WebNetSlotOccupied(captor) ? test_capture_target(GameInfo.players[captor].car) : NULL;
    return reference ? WebSnapshotLiveHandle(*reference) : UINT32_MAX;
}

EMSCRIPTEN_KEEPALIVE int WebTestFlameContact(s32 source_slot, s32 target_slot)
{
    if (!WebNetSlotOccupied(target_slot) || !GameInfo.players[target_slot].car
        || (source_slot >= 0
            && (!WebNetSlotOccupied(source_slot) || !GameInfo.players[source_slot].car))
        || ObjectCurrentProcess)
        return 0;
    Car* target = GameInfo.players[target_slot].car;
    WebParticipantId source = WebParticipantIdentity(source_slot);
    SVECTOR position;
    ApplyMatrixWithTranslationSV(&target->transform, &target->collision_box.center, &position);
    WebCheckpointArenaSelect(1);
    Anim* flame = ObjectCreateWithParticipant("anim", 0, source, "fire", ONE / 2, &position, NULL,
        ANIM_DURATION_INFINITE, ANIM_SOUND_DISABLED);
    if (flame) {
        ObjectInteractObjectHeaderWithObjectHeader(ObjectGetHeader(target), ObjectGetHeader(flame));
        ObjectDestroy(flame);
    }
    WebCheckpointArenaSelect(0);
    if (!target->fire_effect)
        return 0;
    target->health = 15;
    return target->burn_source.low == source.low && target->burn_source.high == source.high;
}

EMSCRIPTEN_KEEPALIVE u32 WebTestBurnIdentity(s32 slot, s32 part)
{
    Car* car = WebNetSlotOccupied(slot) ? GameInfo.players[slot].car : NULL;
    if (!car)
        return 0;
    return part == 0                    ? car->burn_source.low
        : part == 1                     ? car->burn_source.high
        : part == 2                     ? car->fire_ticks
        : part == 3 && car->fire_effect ? ObjectGetHeader(car->fire_effect)->participant.low
                                        : 0;
}

EMSCRIPTEN_KEEPALIVE int WebTestBurnOwnContact(s32 slot)
{
    Car* car = WebNetSlotOccupied(slot) ? GameInfo.players[slot].car : NULL;
    if (!car || !car->fire_effect)
        return 0;
    const s32 ticks = car->fire_ticks;
    WebParticipantId source = car->burn_source;
    WebCheckpointArenaSelect(1);
    ObjectInteractObjectHeaderWithObjectHeader(
        ObjectGetHeader(car), ObjectGetHeader(car->fire_effect));
    WebCheckpointArenaSelect(0);
    return ticks == car->fire_ticks && source.low == car->burn_source.low
        && source.high == car->burn_source.high;
}

EMSCRIPTEN_KEEPALIVE int WebTestParticipantDamageContract(s32 slot)
{
    Car* car = WebNetSlotOccupied(slot) ? GameInfo.players[slot].car : NULL;
    if (!car)
        return -1;
    if (OSSymbolGetAddress("CarApplyDamage"))
        return -2;
    if (!OSSymbolGetAddress("CarApplyParticipantDamage"))
        return -3;
    if (ObjectCurrentProcess)
        return -4;
    const s32 first_serial = ObjectNextSerial;
    WebCheckpointArenaSelect(1);
    LightningEmitter* created = LightnClassCount > 0
        ? ObjectCreateWithParticipant("weaponLightningEmitter", 0, WebParticipantIdentity(slot),
              LightnClasses[0].name, &car->position)
        : NULL;
    s32 result = created != NULL;
    WebCheckpointArenaSelect(0);
    if (!result)
        return -5;
    s32 count = 0;
    WebParticipantId source = WebParticipantIdentity(slot);
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list)
        for (const Tm4ObjectHeader* header = ObjectLists[list].first; header;
             header = header->next) {
            if (header->serial < first_serial || strcmp(header->name, "weaponLightningEmitter"))
                continue;
            if (header->owner || header->participant.low != source.low
                || header->participant.high != source.high)
                return -6;
            const LightningEmitter* emitter = ObjectGetPayload(header);
            if (!emitter->bolts[0])
                return -7;
            WebParticipantId child = WebParticipantObjectIdentity(emitter->bolts[0]);
            if (child.low != source.low || child.high != source.high)
                return -8;
            ++count;
        }
    return count;
}

void WeaponSpawnImpactObject(s32 x, s32 y, s32 z, u32 low, u32 high);
void WeaponSpawnMovingExplosion(s32 x, s32 y, s32 z, s32 scale, s32 speed);
EMSCRIPTEN_KEEPALIVE u32 WebTestCreateParticipantWaveTimer(s32 slot)
{
    if (!WebNetSlotOccupied(slot))
        return 0;
    WebParticipantId source = WebParticipantIdentity(slot);
    WebCheckpointArenaSelect(1);
    void* timer = ObjectCreateWithParticipant("timer", 0, source, 1, WeaponSpawnImpactObject, 5,
        -16000, -10000, -16000, source.low, source.high);
    void* cosmetic = ObjectCreateWithParticipant(
        "timer", 0, source, 1, WeaponSpawnMovingExplosion, 5, -16000, -10000, -16000, 2048, 0);
    if (!cosmetic && timer) {
        ObjectDestroy(timer);
        timer = NULL;
    }
    WebCheckpointArenaSelect(0);
    return timer ? ObjectGetHeader(timer)->serial + 1u : 0;
}

EMSCRIPTEN_KEEPALIVE int WebTestSetParticipantResults(s32 slot, s32 frags, s32 deaths)
{
    if (!WebNetSlotOccupied(slot) || frags < 0 || deaths < 0)
        return 0;
    WebParticipantState state;
    WebParticipantCapture(&state);
    state.slots[slot].frags = frags;
    state.slots[slot].deaths = deaths;
    WebParticipantRestore(&state);
    return 1;
}

EMSCRIPTEN_KEEPALIVE int WebTestKillParticipant(s32 slot)
{
    if (!WebNetSlotOccupied(slot) || !GameInfo.players[slot].car)
        return 0;
    participant_kill_slots |= 1u << slot;
    return 1;
}

/* Poison only the alignment gap, never rotation coefficients or translation. */
EMSCRIPTEN_KEEPALIVE u32 WebTestSetDebrisMatrixPadding(u8 value)
{
    const size_t begin = sizeof(((MATRIX*)0)->m);
    const size_t length = offsetof(MATRIX, t) - begin;
    u32 count = 0;
    for (Tm4ObjectHeader* object = ObjectLists[OBJECT_LIST_DEFAULT].first; object;
         object = object->next) {
        if (strcmp(object->name, "carpart"))
            continue;
        Carpart* part = ObjectGetPayload(object);
        memset((u8*)&part->rotation_step + begin, value, length);
        memset((u8*)&part->local_to_world + begin, value, length);
        ++count;
    }
    return count;
}

EMSCRIPTEN_KEEPALIVE int WebTestCreatePaddingEffects(void)
{
    Car* car = GameInfo.players[0].car;
    if (!car || !FlameClassCount)
        return 0;
    FlamePlacement placement
        = { .world_position = car->position, .world_direction = { 0, -ONE, 0, 0 } };
    SVECTOR axis = { 0, ONE, 0, 0 };
    WebCheckpointArenaSelect(1);
    void* ring = ObjectCreate("fireRing", 0, "fire", &car->position, 1536, 192, NULL, &axis, 4096);
    void* flame = ObjectCreate("flameEmitter", 0, FlameClasses[0].name, NULL, &placement);
    WebCheckpointArenaSelect(0);
    return ring && flame;
}

EMSCRIPTEN_KEEPALIVE u32 WebTestSetEffectPadding(u32 field, u8 value)
{
    u32 count = 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* object = ObjectLists[list].first; object; object = object->next) {
            if (!strcmp(object->name, "fireRing")) {
                FireRing* ring = ObjectGetPayload(object);
                if (field == 0) {
                    memset(&ring->axis.pad, value, sizeof(ring->axis.pad));
                    ++count;
                } else if (field == 1) {
                    for (s32 i = 0; i < ring->particle_count; ++i) {
                        memset(&ring->particles[i].position.pad, value,
                            sizeof(ring->particles[i].position.pad));
                        ++count;
                    }
                }
            } else if (!strcmp(object->name, "flameEmitter") && (field == 2 || field == 3)) {
                FlameEmitter* flame = ObjectGetPayload(object);
                s16* pad = field == 2 ? &flame->world_direction.pad : &flame->world_velocity.pad;
                memset(pad, value, sizeof(*pad));
                ++count;
            } else if (!strcmp(object->name, "carpart")) {
                WebCarpart* debris = ObjectGetPayload(object);
                if (field == 4) {
                    memset(&debris->part.collision_origin.pad, value,
                        sizeof(debris->part.collision_origin.pad));
                    ++count;
                } else if (field == 5) {
                    const size_t begin = offsetof(CarRenderFace, reflection) + sizeof(u8);
                    const size_t length = offsetof(CarRenderFace, texture) - begin;
                    for (s32 i = 0; i < debris->group.frames[CAR_RENDER_FRAME_DAMAGED].face_count;
                         ++i) {
                        memset((u8*)&debris->faces[i] + begin, value, length);
                        ++count;
                    }
                }
            }
        }
    }
    return count;
}

EMSCRIPTEN_KEEPALIVE int WebTestHitParticipant(u32 handle, s32 slot)
{
    const void* object = WebSnapshotFindLiveObject(handle);
    if (!object || strcmp(ObjectGetHeader(object)->name, "weaponProjectile")
        || !WebNetSlotOccupied(slot) || !GameInfo.players[slot].car)
        return 0;
    participant_hit_projectiles[slot] = handle;
    return 1;
}

EMSCRIPTEN_KEEPALIVE u32 WebTestProjectileProvenance(u32 handle, s32 part)
{
    const void* object = WebSnapshotFindLiveObject(handle);
    if (!object)
        return 0;
    const Tm4ObjectHeader* header = ObjectGetHeader(object);
    return part == 0 ? header->participant.low
        : part == 1  ? header->participant.high
                     : header->owner != NULL;
}

EMSCRIPTEN_KEEPALIVE u32 WebTestAttributedWaves(u32 low, u32 high)
{
    u32 count = 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list)
        for (const Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next)
            if (!strcmp(header->name, "explosionShockWave") && header->participant.low == low
                && header->participant.high == high)
                ++count;
    return count;
}

static s32 respawn_request_slot = -1, respawn_request_failure = -1;
static u32 respawn_request_delay, respawn_request_retry, respawn_request_attempts;
void WebTestFailSimulationAllocation(s32 after);

EMSCRIPTEN_KEEPALIVE int WebTestScheduleRespawn(
    s32 slot, u32 delay, u32 retry, u32 attempts, s32 fail_allocation)
{
    WebParticipantState state;
    WebParticipantCapture(&state);
    if (!WebNetSlotOccupied(slot) || GameInfo.players[slot].car
        || state.respawns[slot].state != WebCarWaiting || respawn_request_slot >= 0)
        return 0;
    respawn_request_slot = slot;
    respawn_request_delay = delay;
    respawn_request_retry = retry;
    respawn_request_attempts = attempts;
    respawn_request_failure = fail_allocation;
    return 1;
}

/* Allocation order for the stock Crusher fixture: three display resolutions,
 * two box polyhedra, pinchers/treads, optional engine audio, then the camera. */
EMSCRIPTEN_KEEPALIVE u32 WebTestCrusherRespawnAllocationBytes(s32 index)
{
    const Car* car = GameInfo.players[0].car;
    if (!car || strcmp(car->character_name, "Crusher") || car->display_list_count != 3)
        return 0;
    switch (index) {
    case 0:
        return sizeof(Tm4ObjectHeader) + sizeof(Car);
    case 1:
        return strlen(car->filename) + 1;
    case 2:
        return ArrayCount(CarWeaponDescriptors) * sizeof(CarWeaponInstance);
    case 3:
        return sizeof(*car->weapons[0].descriptor);
    case 4:
        return WebNetSlotCapacity() * sizeof(*car->ai.attacker_damage);
    case 5:
        return WebNetSlotCapacity() * sizeof(*car->ai.nearby_records);
    case 6:
        return car->turbo_emitter_count * sizeof(*car->turbo_emitters);
    case 7:
        return car->normal_count * sizeof(*car->colors);
    case 8:
        return car->display_list_count * sizeof(*car->display_lists);
    case 9:
    case 10:
    case 11:
        return car->display_lists[index - 9].group_count * sizeof(CarRenderGroupEntry);
    case 12:
    case 13: {
        const Polyhedron* shape
            = index == 12 ? car->collision_box.polyhedron : car->physics_box.polyhedron;
        if (!shape)
            return 0;
        return MemGetBlockSize(shape);
    }
    case 14:
        return sizeof(CrusherPinchers);
    case 15: {
        u32 faces = 0;
        for (s32 i = 0; i < car->display_list_count; ++i)
            faces += car->display_lists[i].face_count;
        return faces * sizeof(CarRenderFace);
    }
    case 16:
        return sizeof(Tm4ObjectHeader) + sizeof(SoundEmitter);
    case 17:
        return car->engine_sound ? car->engine_sound->voice_count * sizeof(SoundEmitterVoice) : 0;
    case 18:
        return sizeof(CarCameraState);
    default:
        return 0;
    }
}

EMSCRIPTEN_KEEPALIVE u32 WebTestCarResource(s32 slot, s32 field)
{
    const Car* car = WebNetSlotOccupied(slot) ? GameInfo.players[slot].car : NULL;
    if (!car)
        return 0;
    switch (field) {
    case 0:
        return !!car->collision_box.polyhedron | (!!car->physics_box.polyhedron << 1);
    case 1:
        return car->engine_sound != NULL;
    case 2:
        return car->turbo_emitter_count;
    case 3:
        return car->transform.t[0];
    case 4:
        return car->transform.t[2];
    case 5:
        return car->controls.throttle_input;
    case 6:
        return car->controls.steering_input;
    case 7:
        return car->controls.machine_gun_active;
    default:
        return 0;
    }
}

EMSCRIPTEN_KEEPALIVE u32 WebTestCarHandle(s32 slot)
{
    return WebNetSlotOccupied(slot) ? WebSnapshotLiveHandle(GameInfo.players[slot].car) : 0;
}

EMSCRIPTEN_KEEPALIVE u32 WebTestRespawnState(s32 slot, s32 field)
{
    WebParticipantState state;
    WebParticipantCapture(&state);
    if (!WebNetSlotOccupied(slot))
        return UINT32_MAX;
    const WebParticipantRespawn* pending = &state.respawns[slot];
    switch (field) {
    case 0:
        return pending->state;
    case 1:
        return pending->due_tick;
    case 2:
        return pending->attempts;
    case 3:
        return pending->remaining;
    case 4:
        return state.models[slot];
    default:
        return UINT32_MAX;
    }
}

void WebTestApplyParticipantActions(void)
{
    if (respawn_request_slot >= 0) {
        WebParticipantScheduleRespawn(respawn_request_slot,
            (u32)MainFrameCount + respawn_request_delay, respawn_request_retry,
            respawn_request_attempts);
        WebTestFailSimulationAllocation(respawn_request_failure);
        respawn_request_slot = -1;
        respawn_request_failure = -1;
    }
    const u32 kills = participant_kill_slots;
    u32 hits[8];
    memcpy(hits, participant_hit_projectiles, sizeof(hits));
    participant_kill_slots = 0;
    memset(participant_hit_projectiles, 0, sizeof(participant_hit_projectiles));
    for (s32 slot = 0; slot < 8; ++slot) {
        if (!(kills & (1u << slot)) || !WebNetSlotOccupied(slot))
            continue;
        Car* car = GameInfo.players[slot].car;
        if (car)
            CarApplyParticipantDamage(car, NULL, WebParticipantObjectIdentity(NULL), 0x7fffffff,
                NULL, "PARTICIPANT TEST");
    }
    for (s32 hit = 0; hit < 8; ++hit) {
        WeaponProjectile* projectile = hits[hit] ? WebSnapshotFindLiveObject(hits[hit]) : NULL;
        if (projectile && WebNetSlotOccupied(hit) && GameInfo.players[hit].car) {
            projectile->bullet.hit_object = GameInfo.players[hit].car;
            projectile->bullet.hit_pending = 1;
            projectile->bullet.motion.fields.world_impact = 0;
            projectile->bullet.impact.fields.world_position
                = ObjectGetHeader(GameInfo.players[hit].car)->position;
        }
    }
}
