#include "port/web/checkpoint.h"
#include "port/web/checkpoint_memory.h"
#include "port/web/net_match.h"
#include "port/web/net_state.h"
#include "port/web/snapshot_session.h"
#include "port/web/snapshot_types.h"
#include "src/main/object/private.h"
#include "src/modules/car/private.h"
#include "src/modules/firing/private.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"
#include "tm4/main/memory.h"
#include "tm4/main/pad.h"
#include "tm4/main/system.h"
#include "tm4/modules/weap.h"
#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

EMSCRIPTEN_KEEPALIVE int WebTestOffsetReplayHeap(void)
{
    return MemAlloc(384) != NULL;
}

EMSCRIPTEN_KEEPALIVE uintptr_t WebTestReplayCarAddress(void)
{
    return (uintptr_t)GameInfo.players[0].car;
}

EMSCRIPTEN_KEEPALIVE int WebTestChangeCheckpointResources(void)
{
    void* allocation = MemAlloc(32);
    if (!allocation)
        return 0;
    MemFree(allocation);
    return 1;
}

EMSCRIPTEN_KEEPALIVE int WebTestCheckpointWorldArenaOverlap(void)
{
    Car* car = GameInfo.players[0].car;
    if (!car)
        return 0;
    WebCheckpointWorldWrite(&car->energy, sizeof(car->energy));
    return 1;
}

EMSCRIPTEN_KEEPALIVE void WebTestLocalCheckpointProjectiles(void)
{
    EM_ASM({ tm4Port.testLiveProjectiles = []; });
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list)
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next)
            if (!strcmp(header->name, "weaponProjectile"))
                EM_ASM({ tm4Port.testLiveProjectiles.push($0); }, header->serial);
}

EMSCRIPTEN_KEEPALIVE void WebTestSnapshotObjects(const char* name)
{
    EM_ASM({ tm4Port.testSnapshotObjects = []; });
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list)
        for (const Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next)
            if (!strcmp(header->name, name))
                EM_ASM({ tm4Port.testSnapshotObjects.push($0); }, header->serial);
}

EMSCRIPTEN_KEEPALIVE int WebTestPerturbNetworkCar(s32 slot)
{
    if (slot < 0 || slot >= ArrayCount(GameInfo.players) || !GameInfo.players[slot].car)
        return 0;
    GameInfo.players[slot].car->energy -= 128;
    return 1;
}

static s32 test_unknown_car_process(Car* car, void* context)
{
    return 1;
}

EMSCRIPTEN_KEEPALIVE int WebTestUnsupportedCarCallback(void)
{
    Car* car = GameInfo.players[0].car;
    if (!WebNetMatchActive() || !car || car->process_callback)
        return 0;
    car->process_callback = test_unknown_car_process;
    WebNetMatchPublishTick();
    return 1;
}

EMSCRIPTEN_KEEPALIVE int WebTestDetonationCheckpointIdentity(void)
{
    Car* first = GameInfo.players[0].car;
    Car* second = GameInfo.players[1].car;
    if (!first || !second)
        return 0;

    for (s32 i = 0; i < CarWeaponCount; ++i) {
        CarWeaponInstance* weapon = &first->weapons[i];
        CarWeaponInstance* alternate = &second->weapons[i];
        if (!weapon->descriptor->detonate || !weapon->descriptor->name
            || !alternate->descriptor->name
            || strcmp(weapon->descriptor->name, alternate->descriptor->name))
            continue;

        void* device = ObjectCreate(
            "weaponBomb", OBJECT_DESTROY_WITH_OWNER, first, "remote", &first->position);
        if (!device)
            return 0;
        CarTrackDetonationDevice(weapon, first, device);
        CarDetonationNode* node = CarDetonationDevices;
        if (!node || node->object != device) {
            ObjectDestroy(device);
            return 0;
        }

        const WebNetStateDigest before = WebNetCaptureDigest(1);
        node->weapon = alternate;
        const WebNetStateDigest reassigned = WebNetCaptureDigest(1);
        node->weapon = NULL;
        const WebNetStateDigest unresolved = WebNetCaptureDigest(1);
        node->weapon = weapon;
        ObjectDestroy(device);
        return !before.unsupported && !reassigned.unsupported && before.cars != reassigned.cars
            && unresolved.unsupported
            && !strcmp(unresolved.unsupported, "detonation device reference");
    }
    return 0;
}

static void test_projectile_destructor(WeaponProjectile* projectile)
{
    (void)projectile;
}

EMSCRIPTEN_KEEPALIVE int WebTestProjectileCheckpointCallbacks(void)
{
    for (Tm4ObjectHeader* object = ObjectLists[OBJECT_LIST_DEFAULT].first; object;
         object = object->next) {
        if (strcmp(object->name, "weaponProjectile"))
            continue;

        WeaponProjectile* projectile = ObjectGetPayload(object);
        const WeaponProjectilePhysics physics = projectile->physics;
        const WeaponProjectileDestroy on_destroy = projectile->on_destroy;
        const WebNetStateDigest before = WebNetCaptureDigest(1);
        projectile->physics = NULL;
        const WebNetStateDigest altered_physics = WebNetCaptureDigest(1);
        projectile->physics = physics;
        projectile->on_destroy = test_projectile_destructor;
        const WebNetStateDigest altered_destructor = WebNetCaptureDigest(1);
        projectile->on_destroy = on_destroy;
        const WebNetStateDigest restored = WebNetCaptureDigest(1);
        return !before.unsupported && !restored.unsupported && restored.objects == before.objects
            && altered_physics.unsupported
            && !strcmp(altered_physics.unsupported, "weaponProjectile")
            && altered_destructor.unsupported
            && !strcmp(altered_destructor.unsupported, "weaponProjectile");
    }
    return 0;
}

void ObjectInteractionSeenInsert(Tm4ObjectHeader* object, Tm4ExtenderSeen** head);

EMSCRIPTEN_KEEPALIVE int WebTestPortableExtenderFixture(void)
{
    Car* first = GameInfo.players[0].car;
    Car* second = GameInfo.players[1].car;
    if (!first || !second)
        return 0;
    WebCheckpointArenaSelect(1);
    ObjectSetInteractionRadius(first, WORLD_CELL_SIZE);
    ObjectSetInteractionRadius(second, WORLD_CELL_SIZE);
    Tm4InteractionExtender* root = ObjectGetHeader(first)->interaction_extenders;
    Tm4InteractionExtender* other = ObjectGetHeader(second)->interaction_extenders;
    if (root)
        ObjectInteractionSeenInsert(ObjectGetHeader(second), &root->seen);
    WebCheckpointArenaSelect(0);
    if (!root || !root->seen || !other)
        return 0;
    for (Tm4ObjectHeader* object = ObjectLists[OBJECT_LIST_INTERACTION_EXTENDERS].first; object;
         object = object->next) {
        if (object->owner == first && ObjectGetPayload(object) != root) {
            EM_ASM(
                { tm4Port.testPortableExtenders = ([ $0, $1 ]); }, object->serial + 1,
                ObjectGetHeader(other)->serial + 1);
            WebNetMatchPublishTick();
            return 1;
        }
    }
    return 0;
}

static WeaponProjectile* test_portable_projectile(void)
{
    for (Tm4ObjectHeader* object = ObjectLists[OBJECT_LIST_DEFAULT].first; object;
         object = object->next)
        if (!strcmp(object->name, "weaponProjectile"))
            return ObjectGetPayload(object);
    return NULL;
}

EMSCRIPTEN_KEEPALIVE u32 WebTestPortableProjectileCapture(void)
{
    WeaponProjectile* projectile = test_portable_projectile();
    if (!projectile)
        return 0;
    u8 bytes[1024], header[256];
    const SnapshotType* type = WebSnapshotObjectType(ObjectGetHeader(projectile));
    const u32 length = type ? WebSnapshotFieldsCapture(type, projectile, bytes, sizeof(bytes)) : 0;
    const u32 header_length
        = WebSnapshotObjectCapture(ObjectGetHeader(projectile), header, sizeof(header));
    if (length && header_length) {
        EM_ASM(
            {
                tm4Port.testPortableProjectile = ({
                    bytes : HEAPU8.slice($0, $0 + $1),
                    header : HEAPU8.slice($2, $2 + $3),
                    projectile : $4,
                    owner : $5,
                    target : $6
                });
            },
            bytes, length, header, header_length, projectile, projectile->owner,
            projectile->target);
        return length;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE int WebTestPortableProjectilePerturb(void)
{
    WeaponProjectile* projectile = test_portable_projectile();
    if (!projectile)
        return 0;
    projectile->bullet.current_world.vx += 240;
    projectile->age_frames++;
    projectile->owner = NULL;
    return 1;
}

static void test_replace_projectile_header(
    Tm4ObjectHeader* old, Tm4ObjectHeader* replacement, s32 square_count)
{
    for (unsigned i = 0; i < OBJECT_LIST_COUNT; ++i) {
        for (Tm4ObjectHeader* object = ObjectLists[i].first; object; object = object->next) {
            if (object == old)
                continue;
            if (object->previous == old)
                object->previous = replacement;
            if (object->owner == ObjectGetPayload(old))
                object->owner = ObjectGetPayload(replacement);
            if (object->next_display == old)
                object->next_display = replacement;
            if (object->next_interaction == old)
                object->next_interaction = replacement;
            if (object->next == old)
                object->next = replacement;
        }
        if (ObjectLists[i].first == old)
            ObjectLists[i].first = replacement;
    }
    for (s32 i = 0; i < square_count; ++i) {
        if (WorldSquares[i].display_objects == old)
            WorldSquares[i].display_objects = replacement;
        if (WorldSquares[i].interaction_objects == old)
            WorldSquares[i].interaction_objects = replacement;
    }
}

EMSCRIPTEN_KEEPALIVE int WebTestPortableProjectileRestore(void)
{
    WeaponProjectile* projectile = test_portable_projectile();
    const s32* square_count = RegGetFileDataS("/world/squares/numSquares");
    u8 bytes[1024], header[256];
    const u32 length = EM_ASM_INT({
        return (tm4Port.testPortableProjectile && tm4Port.testPortableProjectile.bytes.length) || 0;
    });
    const u32 header_length = EM_ASM_INT({
        return (tm4Port.testPortableProjectile && tm4Port.testPortableProjectile.header.length)
            || 0;
    });
    if (!projectile || !square_count || !length || length > sizeof(bytes) || !header_length
        || header_length > sizeof(header))
        return 0;
    EM_ASM(
        {
            HEAPU8.set(tm4Port.testPortableProjectile.bytes, $0);
            HEAPU8.set(tm4Port.testPortableProjectile.header, $1);
        },
        bytes, header);
    WebCheckpointArenaSelect(1);
    Tm4ObjectHeader* object = WebSnapshotObjectAllocate(header, header_length);
    Tm4ObjectHeader* old = ObjectGetHeader(projectile);
    const SnapshotType* type = object ? WebSnapshotObjectType(object) : NULL;
    int result = type && object->serial == old->serial && object->class_index == old->class_index
        && WebSnapshotObjectBind(object, header, header_length, WebSnapshotFindLiveObject)
        && WebSnapshotFieldsRestore(
            type, ObjectGetPayload(object), bytes, length, WebSnapshotFindLiveObject);
    if (result) {
        test_replace_projectile_header(old, object, *square_count);
        WebSnapshotFieldsRelease(type, projectile);
        MemFree(old);
    } else if (object) {
        if (type)
            WebSnapshotFieldsRelease(type, ObjectGetPayload(object));
        if (object->class_index == -1)
            MemFree(object->name);
        MemFree(object);
    }
    WebCheckpointArenaSelect(0);
    return result;
}

EMSCRIPTEN_KEEPALIVE u32 WebTestPortableCarCapture(s32 slot)
{
    if (slot < 0 || slot >= ArrayCount(GameInfo.players))
        return 0;
    Car* car = GameInfo.players[slot].car;
    u8 bytes[4096];
    const SnapshotType* type = car ? WebSnapshotObjectType(ObjectGetHeader(car)) : NULL;
    const u32 length = type ? WebSnapshotFieldsCapture(type, car, bytes, sizeof(bytes)) : 0;
    if (length)
        EM_ASM({ tm4Port.testPortableCar = HEAPU8.slice($0, $0 + $1); }, bytes, length);
    return length;
}

EMSCRIPTEN_KEEPALIVE int WebTestPortableCarPerturb(s32 slot)
{
    if (slot < 0 || slot >= ArrayCount(GameInfo.players) || !GameInfo.players[slot].car)
        return 0;
    Car* car = GameInfo.players[slot].car;
    car->transform.t[0] -= 140;
    car->turbo_fuel -= 70;
    car->controls.steering_input ^= 32;
    car->wheels[0].angular_velocity += 91;
    car->particles[0].velocity_q12.vz += 53;
    car->engine_sound = NULL;
    return 1;
}

EMSCRIPTEN_KEEPALIVE int WebTestPortableCarRestore(s32 slot)
{
    if (slot < 0 || slot >= ArrayCount(GameInfo.players))
        return 0;
    Car* car = GameInfo.players[slot].car;
    u8 bytes[4096];
    const u32 length
        = EM_ASM_INT({ return (tm4Port.testPortableCar && tm4Port.testPortableCar.length) || 0; });
    if (!car || !length || length > sizeof(bytes))
        return 0;
    EM_ASM({ HEAPU8.set(tm4Port.testPortableCar, $0); }, bytes);
    if (!WebCheckpointCapture(MainFrameCount, 0))
        return 0;
    WebCheckpointArenaSelect(1);
    const SnapshotType* type = WebSnapshotObjectType(ObjectGetHeader(car));
    int result
        = type && WebSnapshotFieldsRestore(type, car, bytes, length, WebSnapshotFindLiveObject);
    WebCheckpointArenaSelect(0);
    if (!result)
        WebCheckpointRestore(MainFrameCount);
    WebCheckpointDiscard();
    return result;
}

enum { TestSessionCapacity = 64 * 1024 };

EMSCRIPTEN_KEEPALIVE u32 WebTestPortableSessionCapture(void)
{
    u8* bytes = malloc(TestSessionCapacity);
    if (!bytes)
        return 0;
    const u32 length = WebSnapshotSessionCapture(bytes, TestSessionCapacity);
    if (length)
        EM_ASM({ tm4Port.testPortableSession = HEAPU8.slice($0, $0 + $1); }, bytes, length);
    free(bytes);
    return length;
}

EMSCRIPTEN_KEEPALIVE int WebTestPortableSessionPerturb(void)
{
    if (!ObjectActiveInteractionCells)
        return 0;
    ObjectActiveInteractionCells = NULL;
    PadJpad[0].buttons ^= 0x40;
    ++ObjectNextSerial;
    rand();
    randrand();
    return 1;
}

EMSCRIPTEN_KEEPALIVE int WebTestPortableSessionRestore(void)
{
    const u32 length = EM_ASM_INT(
        { return (tm4Port.testPortableSession && tm4Port.testPortableSession.length) || 0; });
    if (!length || length > TestSessionCapacity)
        return 0;
    u8* bytes = malloc(length);
    if (!bytes)
        return 0;
    EM_ASM({ HEAPU8.set(tm4Port.testPortableSession, $0); }, bytes);
    WebCheckpointArenaSelect(1);
    int result = WebSnapshotSessionRestore(bytes, length, WebSnapshotFindLiveObject);
    WebCheckpointArenaSelect(0);
    free(bytes);
    return result;
}
