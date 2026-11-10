/* Diagnostic entry points only; not linked into the normal browser target. */
#include "test_hooks.h"
#include "checkpoint.h"
#include "net_state.h"
#include "src/modules/menu/private.h"
#include "src/main/object/private.h"
#include "src/modules/menu/private.h"
#include "src/modules/car/private.h"
#include "src/modules/cars/c_crush/private.h"
#include "src/modules/cars/shovel.h"
#include "src/modules/levels/w_carni/private.h"
#include "src/modules/levels/w_neon/private.h"
#include "src/modules/levels/w_oil/private.h"
#include "src/modules/levels/w_yard/private.h"
#include "overlays.h"
#include "tm4/main/game.h"
#include "tm4/main/pad.h"
#include "tm4/main/system.h"
#include "tm4/main/tournament.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/conveyer.h"
#include "tm4/modules/destry.h"
#include "tm4/modules/interact.h"
#include "tm4/modules/jumbo.h"
#include "tm4/modules/jumppad.h"
#include "tm4/modules/power.h"
#include "tm4/modules/tele.h"
#include "tm4/modules/weap.h"
#include "tm4/vector.h"
#include <emscripten.h>
#include <stdint.h>
#include <string.h>
#include <strings.h>

EMSCRIPTEN_KEEPALIVE void WebTestInspectObjectCallbacks(void)
{
    EM_ASM({ tm4Port.testObjectCallbacks = []; });
    for (s32 i = 0; i < ObjectClassCount; ++i) {
        Tm4ObjectClass* object_class = &ObjectClasses[i];
        EM_ASM(
            {
                const name = UTF8ToString($0);
                const kinds = ([
                    'constructor', 'instance_constructor', 'process', 'display', 'destructor'
                ]);
                const pointers = ([ $1, $2, $3, $4, $5 ]);
                for (let index = 0; index < pointers.length; ++index) {
                    const pointer = pointers[index];
                    if (pointer)
                        tm4Port.testObjectCallbacks.push({
                            name : name,
                            kind : kinds[index],
                            pointer : pointer,
                            target : __indirect_function_table.get(pointer)
                        });
                }
            },
            object_class->name, object_class->constructor, object_class->instance_constructor,
            object_class->process, object_class->display, object_class->destructor);
        for (s32 j = 0; j <= i; ++j) {
            Tm4ObjectInteractionCallback callback
                = ObjectInteractionPairs[i * (i + 1) / 2 + j].callback;
            if (!callback)
                continue;
            EM_ASM(
                {
                    tm4Port.testObjectCallbacks.push({
                        name : UTF8ToString($0) + '/' + UTF8ToString($1),
                        kind : 'interaction',
                        pointer : $2,
                        target : __indirect_function_table.get($2)
                    });
                },
                object_class->name, ObjectClasses[j].name, callback);
        }
    }
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* object = ObjectLists[list].first; object; object = object->next) {
            EM_ASM(
                {
                    const name = UTF8ToString($0) + '#' + $1;
                    const kinds = ([ 'process', 'display', 'destructor', 'interaction' ]);
                    const pointers = ([ $2, $3, $4, $5 ]);
                    for (let index = 0; index < pointers.length; ++index) {
                        const pointer = pointers[index];
                        if (pointer)
                            tm4Port.testObjectCallbacks.push({
                                name : name,
                                kind : kinds[index],
                                pointer : pointer,
                                target : __indirect_function_table.get(pointer)
                            });
                    }
                },
                object->name, object->serial, object->process, object->display, object->destructor,
                object->interact);
        }
    }
}

EMSCRIPTEN_KEEPALIVE int WebTestOffsetReplayHeap(void)
{
    return MemAlloc(384) != NULL;
}

EMSCRIPTEN_KEEPALIVE uintptr_t WebTestReplayCarAddress(void)
{
    return (uintptr_t)GameInfo.players[0].car;
}

EMSCRIPTEN_KEEPALIVE int WebTestNetworkPlaybackVoices(void)
{
    int count = 0;
    for (Tm4ObjectHeader* object = ObjectLists[OBJECT_LIST_SOUND].first; object;
         object = object->next) {
        const SoundEmitter* emitter = ObjectGetPayload(object);
        for (s32 i = 0; i < emitter->voice_count; ++i)
            count += emitter->voices[i].voice_id >= 0;
    }
    return count;
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

EMSCRIPTEN_KEEPALIVE int WebTestPerturbNetworkCar(s32 slot)
{
    if (slot < 0 || slot >= ArrayCount(GameInfo.players) || !GameInfo.players[slot].car)
        return 0;
    GameInfo.players[slot].car->energy -= 128;
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
            && unresolved.unsupported && !strcmp(unresolved.unsupported, "detonation device reference");
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
            && altered_physics.unsupported && !strcmp(altered_physics.unsupported, "weaponProjectile")
            && altered_destructor.unsupported
            && !strcmp(altered_destructor.unsupported, "weaponProjectile");
    }
    return 0;
}

static void test_approach_scenery(void);
static void test_coop_actions(void);
static void test_damage_helicopter(void);

static PowerupState* test_pickup;
static s32 test_weapon_index;
static MATRIX test_car_transform;
static int defeat_player_pending;

EMSCRIPTEN_KEEPALIVE s32 WebTestApproachPickup(void)
{
    Car* car = GameInfo.players[0].car;
    if (!car)
        return 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* h = ObjectLists[list].first; h; h = h->next) {
            if (strcmp(h->name, "powerup"))
                continue;
            PowerupState* power = ObjectGetPayload(h);
            if (!power->position.fields.active || !power->respawn_delay_ticks
                || power->respawn_delay_ticks == POWERUP_RESPAWN_DISABLED)
                continue;
            for (s32 i = 0; i < 20; ++i) {
                CarWeaponInstance* weapon = &car->weapons[i];
                if (!weapon->descriptor->name || strcasecmp(weapon->descriptor->name, power->name)
                    || weapon->amount >= weapon->descriptor->maximum)
                    continue;
                test_pickup = power;
                test_weapon_index = i;
                test_car_transform = car->transform;
                MATRIX target = car->transform;
                target.t[0] = power->position.fields.xyz.vx;
                target.t[1] = power->position.fields.xyz.vy;
                target.t[2] = power->position.fields.xyz.vz;
                CarOrientWithMatrix(car, &target);
                EM_ASM(
                    {
                        tm4Port.testPickup = ({
                            name : UTF8ToString($0),
                            before : $1,
                            units : $2,
                            maximum : $3,
                            respawnTicks : $4
                        });
                    },
                    power->name, weapon->amount, power->units, weapon->descriptor->maximum,
                    power->respawn_delay_ticks);
                return 1;
            }
        }
    }
    return 0;
}
EMSCRIPTEN_KEEPALIVE s32 WebTestPickupActive(void)
{
    return test_pickup ? test_pickup->position.fields.active : -1;
}
EMSCRIPTEN_KEEPALIVE s32 WebTestPickupAmount(void)
{
    Car* car = GameInfo.players[0].car;
    return car ? car->weapons[test_weapon_index].amount : -1;
}
EMSCRIPTEN_KEEPALIVE void WebTestLeavePickup(void)
{
    Car* car = GameInfo.players[0].car;
    if (car)
        CarOrientWithMatrix(car, &test_car_transform);
}

EMSCRIPTEN_KEEPALIVE void WebTestDamagePlayer(void)
{
    defeat_player_pending = 1;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestSupplyWeapon(s32 index)
{
    Car* car = GameInfo.players[0].car;
    if (!car || index < 0 || index >= CarWeaponCount)
        return 0;
    CarWeaponInstance* weapon = &car->weapons[index];
    AddInventoryToCar(car, weapon->descriptor->name, 2);
    return weapon->amount;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestSupplyProximity(void)
{
    Car* car = GameInfo.players[0].car;
    if (!car)
        return 0;
    AddInventoryToCar(car, "Proximity", 2);
    for (s32 i = 0; i < 20; ++i) {
        CarWeaponInstance* weapon = &car->weapons[i];
        if (weapon->descriptor->name && !strcasecmp(weapon->descriptor->name, "Proximity"))
            return weapon->amount;
    }
    return 0;
}

static Car* test_weapon_target;

EMSCRIPTEN_KEEPALIVE s32 WebTestPlaceWeaponTarget(s32 distance)
{
    Car* player = GameInfo.players[0].car;
    if (!player)
        return 0;
    test_weapon_target = NULL;
    for (s32 i = 0; i < GameInfo.car_count; ++i) {
        Car* car = GameInfo.cars[i];
        if (car == player)
            continue;
        CarAiProcessFunctionDisable(car);
        memset(&car->controls, 0, sizeof(car->controls));
        if (!test_weapon_target)
            test_weapon_target = car;
    }
    if (!test_weapon_target)
        return 0;
    MATRIX target = player->transform;
    for (s32 i = 0; i < 3; ++i)
        target.t[i] += (player->transform.m[i][2] * distance) >> 12;
    CarOrientWithMatrix(test_weapon_target, &target);
    test_weapon_target->shield_ticks = 0;
    return test_weapon_target->health;
}

/* Use ordinary weapon impacts to finish a network test round. */
EMSCRIPTEN_KEEPALIVE s32 WebTestPrepareNetworkDuel(s32 distance)
{
    if (WebTestPlaceWeaponTarget(distance) <= 0)
        return 0;
    test_weapon_target->health = 1;
    return 1;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestNetworkCarContact(void)
{
    Car* player = GameInfo.players[0].car;
    return player && player->collision_history != NULL;
}

/* Keep radial-wave targets on the player's floor and outside walls or ledges. */
EMSCRIPTEN_KEEPALIVE s32 WebTestPlaceRadialWeaponTarget(s32 distance)
{
    s32 health = WebTestPlaceWeaponTarget(distance);
    if (health <= 0)
        return health;
    Car* player = GameInfo.players[0].car;
    s32 x = player->transform.t[0], y = player->transform.t[1], z = player->transform.t[2];
    s32 floor = GetHeight3d(x, y - 256, z);
    for (s32 angle = 0; angle < 4096; angle += 512) {
        s32 dx = (rsin(angle) * distance) >> 12;
        s32 dz = (rcos(angle) * distance) >> 12;
        s32 step;
        for (step = 1; step <= 8; ++step) {
            s32 height = GetHeight3d(x + dx * step / 8, y - 256, z + dz * step / 8);
            if (height < floor - 16 || height > floor + 16)
                break;
        }
        if (step <= 8)
            continue;
        SVECTOR start = { x, y - 64, z, 0 };
        SVECTOR end = { x + dx, y - 64, z + dz, 0 };
        Tm4WorldHit hit;
        if (IntersectWorldWithRay(&start, &end, 0, &hit))
            continue;
        MATRIX placement = player->transform;
        placement.t[0] += dx;
        placement.t[2] += dz;
        CarOrientWithMatrix(test_weapon_target, &placement);
        return health;
    }
    return -1;
}

/* Place a homing target on a clear, level ray and face the launcher toward it. */
EMSCRIPTEN_KEEPALIVE s32 WebTestPlaceEnergyTarget(s32 rear)
{
    s32 health = WebTestPlaceRadialWeaponTarget(1200);
    if (health <= 0)
        return health;
    Car* player = GameInfo.players[0].car;
    MATRIX placement = player->transform;
    SVECTOR direction = { test_weapon_target->transform.t[0] - placement.t[0], 0,
        test_weapon_target->transform.t[2] - placement.t[2], 0 };
    if (rear) {
        direction.vx = -direction.vx;
        direction.vz = -direction.vz;
    }
    BuildMatrix(&placement, &direction);
    CarOrientWithMatrix(player, &placement);
    return health;
}

/* The random spawn can start with only one pickup type inside the camera view. */
EMSCRIPTEN_KEEPALIVE int WebTestPlaceMotionPickups(void)
{
    const Camera* camera = GameInfo.players[0].camera;
    if (!camera)
        return 0;
    const MATRIX* view = &camera->camera_to_world;
    int count = 0;
    for (s32 side = -1; side <= 1; side += 2) {
        s32 position[3];
        for (s32 i = 0; i < 3; ++i)
            position[i] = view->t[i] + (view->m[i][2] * 750 + view->m[i][0] * side * 175) / ONE;
        if (ObjectCreate("powerup", 0, side < 0 ? "health" : "homing", -1, -1, position[0],
                position[1], position[2]))
            ++count;
    }
    return count;
}

/* Launch in the active view so the motion check is independent of Rain's landing site. */
EMSCRIPTEN_KEEPALIVE u32 WebTestSpawnMotionFireball(void)
{
    const Car* car = GameInfo.players[0].car;
    if (!car)
        return 0;
    const MATRIX* transform = &car->transform;
    s32 forward_x = transform->m[0][2], forward_z = transform->m[2][2];
    SVECTOR position = { transform->t[0] + forward_x / 16, transform->t[1] - 160,
        transform->t[2] + forward_z / 16, 0 };
    SVECTOR velocity = { forward_x / 2, -1024, forward_z / 2, 0 };
    return (u32)ObjectCreate("weaponFireball", 0, &position, &velocity);
}

void WebTestMotionInput(void)
{
    if (!EM_ASM_INT({ return !!tm4Port.testMotionSeed; }))
        return;
    /* Apply the same digital controls at the same game ticks in each fresh match. */
    u16* actions = GameInfo.players[0].bindings[0].actions;
    u16 buttons = 0, previous = 0;
    s32 tick = GetCurrentTime();
    if (tick >= 19 && tick < 90)
        buttons |= actions[GameControlGas];
    if (tick >= 20 && tick <= 90)
        previous |= actions[GameControlGas];
    if (tick >= 37 && tick < 70)
        buttons |= actions[GameControlSteerRight];
    if (tick >= 38 && tick <= 70)
        previous |= actions[GameControlSteerRight];
    if (tick >= 105 && tick < 109)
        buttons |= actions[GameControlLookBack];
    if (tick >= 106 && tick <= 109)
        previous |= actions[GameControlLookBack];
    PadCache* pad = &PadJpad[0];
    pad->buttons = buttons;
    pad->previous_buttons = previous;
    pad->pressed_buttons = buttons & ~previous;
    pad->released_buttons = previous & ~buttons;
    if (tick == 9)
        WebTestPlaceMotionPickups();
    if (tick == 28)
        WebTestSpawnMotionFireball();
    if (tick == 112 && GameInfo.players[0].car) {
        Car* car = GameInfo.players[0].car;
        MATRIX target = car->transform;
        target.t[1] -= 128;
        CarOrientWithMatrix(car, &target);
    }
}

EMSCRIPTEN_KEEPALIVE s32 WebTestWeaponTargetHealth(void)
{
    return test_weapon_target ? test_weapon_target->health : -1;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestWeaponTargetBurning(void)
{
    return test_weapon_target ? test_weapon_target->fire_ticks : 0;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestIgniteGround(void)
{
    Car* player = GameInfo.players[0].car;
    Tm4WorldHit hit;
    if (!player)
        return 0;
    SVECTOR start = player->position, end = start;
    start.vy -= 128;
    end.vy += 1024;
    if (!IntersectWorldWithRay(&start, &end, 0, &hit))
        return 0;
    SVECTOR point;
    CopyVectorToShortVectorRoundedQ12(&point, &hit.position);
    InteractWithFlammableTerrainPoly(hit.polygon, &point);
    return 1;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestFlameEmitterCount(void)
{
    s32 count = 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list)
        for (Tm4ObjectHeader* h = ObjectLists[list].first; h; h = h->next)
            if (!strcmp(h->name, "flameEmitter"))
                ++count;
    return count;
}

s32 CarLaunchLightning(Car*, void*, CarWeaponInstance*, s32);
EMSCRIPTEN_KEEPALIVE s32 WebTestPrepareLevelLightning(void)
{
    Car* player = GameInfo.players[0].car;
    CarMount* points = RegGetFileDataS("/objects/weapon/lightningEmitter/points");
    s32 count = RegGetFileArraySizeS("/objects/weapon/lightningEmitter/points");
    u16* range = RegGetFileDataS("/objects/weapon/lightningEmitter/level/range");
    EM_ASM({ tm4Port.testLightningPointCount = $0; }, count);
    if (!player)
        return -1;
    if (!points || !range || count <= 0)
        return -2;
    for (s32 i = 0; i < 20; ++i) {
        CarWeaponInstance* weapon = &player->weapons[i];
        if (weapon->descriptor->launch != CarLaunchLightning)
            continue;
        AddInventoryToCar(player, weapon->descriptor->name, 2);
        if (!WebTestPlaceWeaponTarget(500))
            return -4;
        MATRIX location = test_weapon_target->transform;
        /* These overhead emitters can sit above empty cells; find nearby road
         * within the resource's range instead of changing the emitter positions. */
        for (s32 point = 0; point < count; ++point) {
            for (s32 dx = -2048; dx <= 2048; dx += 256) {
                for (s32 dz = -2048; dz <= 2048; dz += 256) {
                    s32 x = points[point].position.vx + dx;
                    s32 z = points[point].position.vz + dz;
                    s32 y = WorldGetHeight(x, z);
                    if (y <= points[point].position.vy || y >= 8192)
                        continue;
                    if (DistanceApprox3d(dx, y - points[point].position.vy, dz) >= *range - 200)
                        continue;
                    location.t[0] = x;
                    location.t[1] = y;
                    location.t[2] = z;
                    CarOrientWithMatrix(test_weapon_target, &location);
                    EM_ASM({ tm4Port.testLightningTarget = ([ $0, $1, $2 ]); }, x, y, z);
                    return i;
                }
            }
        }
        return -5;
    }
    return -3;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestApproachLevelTrigger(s32 jump, s32 enter)
{
    Car* car = GameInfo.players[0].car;
    if (!car)
        return 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next) {
            if (strcmp(header->name, jump ? "jumppad" : "teleporter"))
                continue;
            /* Use a placed instance, not an interaction extender owned by it. */
            if (header->owner)
                continue;
            MATRIX location = car->transform;
            IdentifyMatrix(&location);
            location.t[0] = header->position.vx;
            location.t[1] = header->position.vy;
            location.t[2] = header->position.vz - (enter ? 0 : 1200);
            CarOrientWithMatrix(car, &location);
            if (jump && enter) {
                Jumppad* pad = ObjectGetPayload(header);
                s32 speed = enter < 0 ? -512 : 512;
                if (pad->one_way)
                    for (s32 i = 0; i < 5; ++i)
                        setVector(&car->particles[i].velocity_q12, pad->direction.vx * speed,
                            pad->direction.vy * speed, pad->direction.vz * speed);
                EM_ASM({ tm4Port.testJumppadOneWay = $0; }, pad->one_way);
            }
            Camera* camera = GameInfo.players[0].camera;
            if (camera && camera->object == car)
                ((CarCameraState*)camera->data)->snap = 1;
            EM_ASM(
                { tm4Port.testTriggerPosition = ([ $0, $1, $2 ]); }, header->position.vx,
                header->position.vy, header->position.vz);
            if (!jump) {
                Teleporter* portal = ObjectGetPayload(header);
                EM_ASM(
                    { tm4Port.testTeleportDestination = ([ $0, $1, $2 ]); },
                    portal->destination_world.vx, portal->destination_world.vy,
                    portal->destination_world.vz);
            }
            return 1;
        }
    }
    return 0;
}

static Destroyable* test_destroyable;
static s32 test_destroyable_serial;
static Tm4CollisionPolygon* test_destroyable_polygon;
static Tm4WorldInfoBundle* test_destroyable_world;
static s32 test_destroyable_faces, test_destroyable_enabled_faces;

static void test_count_face(Tm4DisplayFace* face, const SVECTOR* vertices)
{
    s32 kind = face->header.color0.components.cd & TM4_FACE_TYPE_MASK;
    s32 enabled = (kind == TM4_FACE_GT3 || kind == TM4_FACE_GT4)
        ? face->gouraud.color3.components.cd
        : face->flat.enabled;
    ++test_destroyable_faces;
    test_destroyable_enabled_faces += !!enabled;
}
EMSCRIPTEN_KEEPALIVE s32 WebTestDestroyablePresent(void)
{
    s32 present = 0, fragments = 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list)
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next) {
            if (ObjectGetPayload(header) == test_destroyable
                && header->serial == test_destroyable_serial)
                present = 1;
            if (!strcmp(header->name, "fragment"))
                ++fragments;
        }
    if (test_destroyable_world) {
        test_destroyable_faces = test_destroyable_enabled_faces = 0;
        WorldObjectDisplayFacesApplyFaceFunction(test_destroyable_world, 0, test_count_face);
        EM_ASM(
            {
                tm4Port.testDestroyable = ({
                    alive : $0,
                    faces : $1,
                    enabledFaces : $2,
                    collisionEnabled : $3,
                    collisionOwned : $4,
                    fragments : $5
                });
            },
            present, test_destroyable_faces, test_destroyable_enabled_faces,
            CollisionPolygonEnabled(test_destroyable_polygon),
            test_destroyable_polygon->owner != NULL, fragments);
    }
    return present;
}
EMSCRIPTEN_KEEPALIVE int WebTestPerturbLocalCheckpoint(void)
{
    rand();
    randrand();
    if (!test_destroyable_world || !WebTestDestroyablePresent())
        return 0;
    WorldObjectSet(test_destroyable_world, 0);
    return 1;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestAimAtDestroyable(void)
{
    Car* car = GameInfo.players[0].car;
    s32* count = RegGetFileDataS("/world/collisionPolys/numCollideInList");
    if (!car || !count || !car->muzzle_count)
        return 0;
    for (s32 i = 0; i < GameInfo.car_count; ++i)
        if (GameInfo.cars[i] != car) {
            CarAiProcessFunctionDisable(GameInfo.cars[i]);
            memset(&GameInfo.cars[i]->controls, 0, sizeof(GameInfo.cars[i]->controls));
        }
    for (s32 i = 0; i < *count; ++i) {
        Tm4CollisionPolygon* polygon = &WorldCollisionPolygons[i];
        if (!polygon->owner || !CollisionPolygonEnabled(polygon)
            || strcmp(ObjectGetHeader(polygon->owner)->name, "destroyable"))
            continue;
        /* Aim at an existing vertical face, from its outward side. */
        if (abs(polygon->normal[1]) > abs(polygon->normal[0]) + abs(polygon->normal[2]))
            continue;
        Destroyable* object = polygon->owner;
        SVECTOR center = { 0 }, normal;
        VECTOR axis = { polygon->normal[0], 0, polygon->normal[2], 0 };
        if (!axis.vx && !axis.vz)
            continue;
        VectorNormalSNew64(&axis, &normal);
        s32 vertices = CollisionPolygonVertexCount(polygon);
        s32 x = 0, y = 0, z = 0;
        for (s32 vertex = 0; vertex < vertices; ++vertex) {
            x += polygon->vertices[vertex].vx;
            y += polygon->vertices[vertex].vy;
            z += polygon->vertices[vertex].vz;
        }
        setVector(&center, x / vertices, y / vertices, z / vertices);
        SVECTOR start = center, end = center;
        start.vx += normal.vx * 700 / ONE;
        start.vz += normal.vz * 700 / ONE;
        end.vx -= normal.vx * 100 / ONE;
        end.vz -= normal.vz * 100 / ONE;
        Tm4WorldHit hit;
        if (!IntersectWorldWithRay(&start, &end, 0, &hit) || hit.owner != object)
            continue;
        MATRIX placement;
        IdentifyMatrix(&placement);
        placement.m[0][2] = -normal.vx;
        placement.m[2][2] = -normal.vz;
        placement.m[0][0] = -normal.vz;
        placement.m[2][0] = normal.vx;
        placement.t[0] = start.vx;
        placement.t[1] = start.vy - car->muzzle_records[0].position.vy;
        placement.t[2] = start.vz;
        CarOrientWithMatrix(car, &placement);
        Camera* camera = GameInfo.players[0].camera;
        if (camera && camera->object == car)
            ((CarCameraState*)camera->data)->snap = 1;
        test_destroyable = object;
        test_destroyable_serial = ObjectGetHeader(object)->serial;
        test_destroyable_polygon = polygon;
        test_destroyable_world = object->world;
        EM_ASM(
            {
                tm4Port.testDestroyableSerial = $0;
                tm4Port.testDestroyableName = UTF8ToString($1);
                tm4Port.testDestroyableHealth = $2;
            },
            test_destroyable_serial, RegGetDirectoryNameP(object->registry), object->hit_points);
        WebTestDestroyablePresent();
        return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestApproachCrane(s32 place_target)
{
    Car* player = GameInfo.players[0].car;
    if (!player)
        return 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next) {
            if (strcmp(header->name, "crane"))
                continue;
            Crane* crane = ObjectGetPayload(header);
            for (s32 i = 0; i < GameInfo.car_count; ++i)
                if (GameInfo.cars[i] != player) {
                    CarAiProcessFunctionDisable(GameInfo.cars[i]);
                    memset(&GameInfo.cars[i]->controls, 0, sizeof(GameInfo.cars[i]->controls));
                }
            MATRIX placement;
            IdentifyMatrix(&placement);
            if (!place_target) {
                Tm4ShortVectorXYZ* position = &ObjectGetHeader(crane->control)->position;
                placement.t[0] = position->vx;
                placement.t[1] = position->vy;
                placement.t[2] = position->vz;
                CarOrientWithMatrix(player, &placement);
            } else {
                Car* target = NULL;
                for (s32 i = 0; i < GameInfo.car_count; ++i)
                    if (GameInfo.cars[i] != player && GameInfo.cars[i]->health > 0) {
                        target = GameInfo.cars[i];
                        break;
                    }
                if (!target)
                    return 0;
                placement.t[0] = crane->magnet_position.vx;
                placement.t[1] = crane->ground_y - 250;
                placement.t[2] = crane->magnet_position.vz;
                CarOrientWithMatrix(target, &placement);
                EM_ASM({ tm4Port.testCraneTargetY = $0; }, target->position.vy);
            }
            return 1;
        }
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestEnterHopper(void)
{
    Car* car = GameInfo.players[0].car;
    if (!car)
        return 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next) {
            if (strcmp(header->name, "deathPoint"))
                continue;
            MATRIX placement;
            IdentifyMatrix(&placement);
            placement.t[0] = header->position.vx;
            placement.t[1] = header->position.vy;
            placement.t[2] = header->position.vz;
            CarOrientWithMatrix(car, &placement);
            return 1;
        }
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestPlaceAugerTarget(void)
{
    s32 health = WebTestPlaceWeaponTarget(0);
    if (health <= 0)
        return health;
    Car* player = GameInfo.players[0].car;
    Car* target = test_weapon_target;
    /* Make actual front/rear box contact, independent of the random opponent's size. */
    s32 offset[3] = {
        player->collision_box.center.vx - target->collision_box.center.vx,
        player->collision_box.center.vy - target->collision_box.center.vy,
        player->collision_box.maximum.vz - target->collision_box.minimum.vz - 32,
    };
    MATRIX placement = player->transform;
    for (s32 axis = 0; axis < 3; ++axis)
        placement.t[axis]
            += (player->transform.m[axis][0] * offset[0] + player->transform.m[axis][1] * offset[1]
                   + player->transform.m[axis][2] * offset[2])
            >> 12;
    CarOrientWithMatrix(target, &placement);
    return health;
}

static int defeat_opponents_pending;
static int deathmatch_rules_pending;
static int deathmatch_test_wins, deathmatch_test_limit, deathmatch_test_advance;

EMSCRIPTEN_KEEPALIVE void WebTestDeathmatchRules(s32 wins, s32 limit, s32 advance)
{
    deathmatch_test_wins = wins;
    deathmatch_test_limit = limit;
    deathmatch_test_advance = advance;
    deathmatch_rules_pending = 1;
}
EMSCRIPTEN_KEEPALIVE void WebTestLoseDeathmatchRound(void)
{
    defeat_player_pending = 1;
}

EMSCRIPTEN_KEEPALIVE void WebTestDefeatOpponents(void)
{
    defeat_opponents_pending = 1;
}

/* Browser commands may arrive during an Asyncify yield; mutate objects at a tick boundary. */
void WebTestApplyPendingActions(void)
{
    test_approach_scenery();
    test_coop_actions();
    test_damage_helicopter();
    if (deathmatch_rules_pending) {
        deathmatch_rules_pending = 0;
        GameInfo.deathmatch_limit_is_wins = deathmatch_test_wins;
        GameInfo.deathmatch_limit = deathmatch_test_limit;
        GameInfo.deathmatch_world_selection = deathmatch_test_advance;
    }
    if (defeat_player_pending) {
        defeat_player_pending = 0;
        Car* player = GameInfo.players[0].car;
        if (player) {
            player->shield_ticks = 0;
            CarApplyDamage(player, NULL, 0x7fffffff, NULL, "DEATHMATCH TEST");
        }
    }
    if (!defeat_opponents_pending)
        return;
    defeat_opponents_pending = 0;
    Car* player = GameInfo.players[0].car;
    for (s32 i = GameInfo.car_count - 1; i >= 0; --i) {
        Car* car = GameInfo.cars[i];
        if (car->control_kind != CAR_CONTROL_ENEMY || car->health <= 0)
            continue;
        car->shield_ticks = 0;
        CarApplyDamage(car, player, 0x7fffffff, NULL, "PROGRESSION TEST");
    }
}

EMSCRIPTEN_KEEPALIVE void WebTestReadMatchState(void)
{
    EM_ASM(
        {
            tm4Port.match = ({
                won : $0,
                lost : $1,
                acceptsInput : $2,
                progress : $3,
                lives : $4,
                opponents : $5,
                mode : $6,
                nextMode : $7,
                rounds : $8,
                roundFinished : $9,
                wins : $10,
                world : UTF8ToString($11),
                saveMenu : $12,
                tournamentWon : $13,
                tournamentWorlds : $14
            });
        },
        GameInfo.world_won, GameInfo.world_lost, GameInfo.tournament_accept_input,
        GameInfo.tournament_progress, GameInfo.players[0].lives, GameInfo.active_computer_count,
        GameInfo.mode, GameInfo.next_mode, GameInfo.deathmatch_rounds, GameInfo.deathmatch_finished,
        GameInfo.players[0].wins, GameInfo.world_name, GameInfo.save_menu, GameInfo.tournament_won,
        GameGetNumberOfTournamentWorlds());
    EM_ASM(
        {
            Object.assign(tm4Port.match, {
                deathmatchAcceptsInput : $0,
                deathmatchNextMode : $1,
                losses : $2,
                limit : $3,
                limitIsWins : $4,
                worldSelection : $5
            });
        },
        GameInfo.deathmatch_accept_input, GameInfo.deathmatch_next_mode, GameInfo.players[0].losses,
        GameInfo.deathmatch_limit, GameInfo.deathmatch_limit_is_wins,
        GameInfo.deathmatch_world_selection);
    EM_ASM(
        { Object.assign(tm4Port.match, { winner : $0, players : [] }); },
        GameInfo.deathmatch_winner);
    for (s32 i = 0; i < GameInfo.player_count; ++i) {
        EM_ASM(
            { tm4Port.match.players.push({ wins : $0, losses : $1 }); }, GameInfo.players[i].wins,
            GameInfo.players[i].losses);
    }
}

EMSCRIPTEN_KEEPALIVE s32 WebTestApproachNeonObject(s32 ufo_pickup)
{
    Car* car = GameInfo.players[0].car;
    if (!car)
        return 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next) {
            if (strcasecmp(header->name, ufo_pickup ? "ufo" : "train"))
                continue;
            if (header->owner)
                continue;
            MATRIX location = car->transform;
            IdentifyMatrix(&location);
            if (ufo_pickup) {
                Ufo* ufo = ObjectGetPayload(header);
                if (!ufo->pickup_world_position)
                    continue;
                location.t[0] = ufo->pickup_world_position->vx;
                location.t[1] = ufo->pickup_world_position->vy;
                location.t[2] = ufo->pickup_world_position->vz;
                EM_ASM(
                    { tm4Port.testUfoPickup = ([ $0, $1, $2 ]); }, location.t[0], location.t[1],
                    location.t[2]);
            } else {
                Train* train = ObjectGetPayload(header);
                location = train->path.local_to_world;
                for (s32 axis = 0; axis < 3; ++axis)
                    location.t[axis] += train->path.local_to_world.m[axis][2] * 1600 / ONE;
            }
            car->shield_ticks = 0;
            CarOrientWithMatrix(car, &location);
            for (s32 i = 0; i < GameInfo.car_count; ++i)
                if (GameInfo.cars[i] != car) {
                    CarAiProcessFunctionDisable(GameInfo.cars[i]);
                    memset(&GameInfo.cars[i]->controls, 0, sizeof(GameInfo.cars[i]->controls));
                }
            Camera* camera = GameInfo.players[0].camera;
            if (camera && camera->object == car)
                ((CarCameraState*)camera->data)->snap = 1;
            return 1;
        }
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestApproachPathObject(s32 helicopter_kind)
{
    Car* car = GameInfo.players[0].car;
    if (!car)
        return 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next) {
            if (strcasecmp(header->name, helicopter_kind ? "helicopter" : "coaster")
                || header->owner)
                continue;
            PathingInfo* path = helicopter_kind ? &((Helicopter*)ObjectGetPayload(header))->path
                                                : &((Coaster*)ObjectGetPayload(header))->path;
            MATRIX location = path->local_to_world;
            if (helicopter_kind) {
                Helicopter* helicopter = ObjectGetPayload(header);
                if (!helicopter->health_powerup)
                    return -1;
                SVECTOR* pickup = &helicopter->health_powerup->position.vector;
                location.t[0] = pickup->vx;
                location.t[1] = pickup->vy;
                location.t[2] = pickup->vz;
                car->health = car->maximum_health / 2;
            } else {
                for (s32 axis = 0; axis < 3; ++axis)
                    location.t[axis] += path->local_to_world.m[axis][2] * 600 / ONE;
            }
            car->shield_ticks = 0;
            CarOrientWithMatrix(car, &location);
            for (s32 i = 0; i < GameInfo.car_count; ++i)
                if (GameInfo.cars[i] != car) {
                    CarAiProcessFunctionDisable(GameInfo.cars[i]);
                    memset(&GameInfo.cars[i]->controls, 0, sizeof(GameInfo.cars[i]->controls));
                }
            Camera* camera = GameInfo.players[0].camera;
            if (camera && camera->object == car)
                ((CarCameraState*)camera->data)->snap = 1;
            return 1;
        }
    }
    return 0;
}

static int helicopter_damage_pending;

static Helicopter* test_find_helicopter(void)
{
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list)
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next)
            if (!strcasecmp(header->name, "helicopter") && !header->owner)
                return ObjectGetPayload(header);
    return NULL;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestDamageHelicopter(void)
{
    helicopter_damage_pending = test_find_helicopter() != NULL;
    return helicopter_damage_pending;
}

static void test_damage_helicopter(void)
{
    if (!helicopter_damage_pending)
        return;
    helicopter_damage_pending = 0;
    Helicopter* helicopter = test_find_helicopter();
    if (helicopter) {
        SVECTOR origin;
        ObjectCopyPosition(&origin, helicopter);
        HelicopterApplyDamage(helicopter, 0x7fffffff, &origin);
    }
}

EMSCRIPTEN_KEEPALIVE void WebTestReadCarModel(void)
{
    Car* car = GameInfo.players[0].car;
    if (!car)
        return;
    u32 uv_hash = 2166136261u;
    s32 count = 0;
    for (s32 i = 0; i < car->display_list_count; ++i)
        count += car->display_lists[i].face_count;
    for (s32 i = 0; i < count; ++i) {
        const u8* uv = (const u8*)&car->faces[i].texture;
        for (s32 j = 0; j < sizeof(car->faces[i].texture); ++j)
            uv_hash = (uv_hash ^ uv[j]) * 16777619u;
    }
    EM_ASM(
        {
            tm4Port.carModel = ({
                file : UTF8ToString($0),
                faces : $1,
                uvHash : $2 >>> 0,
                windupAngle : $3,
                leftWheel : $4,
                rightWheel : $5
            });
        },
        car->filename, count, uv_hash,
        !strcasecmp(car->filename, "toy") && car->callback_context ? *(s32*)car->callback_context
                                                                   : -1,
        car->wheels[3].rotation, car->wheels[2].rotation);
}

EMSCRIPTEN_KEEPALIVE s32 WebTestReadCarGrab(void)
{
    Car* car = GameInfo.players[0].car;
    if (!car || !car->callback_context)
        return 0;
    Car* target;
    s32 angle, remaining;
    SoundEmitter* sound;
    if (!strcasecmp(car->filename, "Crusher")) {
        CrusherPinchers* pinchers = car->callback_context;
        target = pinchers->target;
        angle = pinchers->lower_angle;
        remaining = pinchers->remaining_crushes;
        sound = pinchers->loop_sound;
    } else if (!strcasecmp(car->filename, "Slam") || !strcasecmp(car->filename, "Trash")) {
        CarShovelState* shovel = car->callback_context;
        target = shovel->target;
        angle = shovel->angle;
        remaining = shovel->remaining_slams;
        sound = shovel->loop_sound;
    } else {
        return 0;
    }
    if (!GameIsCarRegistered(target))
        target = NULL;
    EM_ASM(
        {
            tm4Port.carGrab = ({
                angle : $0,
                remaining : $1,
                holding : !!$2,
                health : $3,
                position : [ $4, $5, $6 ],
                sound : !!$7
            });
        },
        angle, remaining, target != NULL, target ? target->health : -1,
        target ? target->position.vx : 0, target ? target->position.vy : 0,
        target ? target->position.vz : 0, sound != NULL);
    return 1;
}

EMSCRIPTEN_KEEPALIVE void WebTestReadNativeModules(void)
{
    EM_ASM(
        {
            tm4Port.nativeModules = ({
                car : !!$0,
                menu : !!$1,
                crusher : !!$2,
                auger : !!$3,
                augerConstructor : !!$4,
                weapon : !!$5,
                weaponConstructor : !!$6
            });
        },
        WebNativeModuleLoaded("o_car.sym"), WebNativeModuleLoaded("menu.sym"),
        WebNativeModuleLoaded("c_crush.sym"), WebNativeModuleLoaded("c_auger.sym"),
        OSSymbolGetAddress("CarAugerClassConstructor"), WebNativeModuleLoaded("o_weap.sym"),
        OSSymbolGetAddress("WeaponClassConstructor"));
}

/* Read-only inspection of original scenery, with placement queued for the next tick. */
static s32 scenery_approach_pending;
static s32 scenery_side;
static MATRIX scenery_camera;
static void test_scenery_camera(void* object, Camera* camera, void* state)
{
    camera->camera_to_world = scenery_camera;
}

static void test_read_screen_face(Tm4DisplayFace* face, const SVECTOR* vertices)
{
    s32 kind = face->header.color0.components.cd & TM4_FACE_TYPE_MASK;
    Tm4CardQuadTexture* texture;
    if (kind == TM4_FACE_FT3 || kind == TM4_FACE_FT4)
        texture = face->flat.texture;
    else if (kind == TM4_FACE_GT3 || kind == TM4_FACE_GT4)
        texture = face->gouraud.texture;
    else
        return;
    EM_ASM(
        {
            tm4Port.scenery.screens.push(
                { side : $0, tpage : $1, uv : [ $2, $3, $4, $5, $6, $7, $8, $9 ] });
        },
        scenery_side, texture->uv.tpage, texture->uv.u0, texture->uv.v0, texture->uv.u1,
        texture->uv.v1, texture->uv.u2, texture->uv.v2, texture->uv.u3, texture->uv.v3);
}
EMSCRIPTEN_KEEPALIVE void WebTestReadScenery(void)
{
    EM_ASM({
        tm4Port.scenery = ({
            conveyers : 0,
            jumbotrons : 0,
            ownedPolygons : 0,
            screens : [],
            surfaceVelocities : [],
            centers : []
        });
    });
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list)
        for (Tm4ObjectHeader* h = ObjectLists[list].first; h; h = h->next) {
            if (!strcmp(h->name, "conveyer")) {
                Conveyer* object = ObjectGetPayload(h);
                EM_ASM(
                    {
                        tm4Port.scenery.conveyers++;
                        tm4Port.scenery.speed = $0;
                    },
                    object->speed);
            } else if (!strcmp(h->name, "jumbotron")) {
                Jumbotron* object = ObjectGetPayload(h);
                scenery_side = object->side;
                EM_ASM(
                    {
                        tm4Port.scenery.jumbotrons++;
                        tm4Port.scenery.centers.push([ $0, $1, $2 ]);
                    },
                    h->position.vx, h->position.vy, h->position.vz);
                WorldObjectDisplayFacesApplyFaceFunction(object->world, 0, test_read_screen_face);
            }
        }
    s32* count = RegGetFileDataS("/world/collisionPolys/numCollideInList");
    if (count)
        for (s32 i = 0; i < *count; ++i) {
            Tm4CollisionPolygon* polygon = &WorldCollisionPolygons[i];
            if (polygon->owner && !strcmp(ObjectGetHeader(polygon->owner)->name, "conveyer"))
                EM_ASM({ tm4Port.scenery.ownedPolygons++; });
        }
    Car* car = GameInfo.players[0].car;
    if (car)
        for (s32 i = 0; i < 5; ++i) {
            Tm4VectorXYZ* v = &car->particles[i].surface_velocity_q12;
            EM_ASM(
                { tm4Port.scenery.surfaceVelocities.push([ $0, $1, $2 ]); }, v->vx, v->vy, v->vz);
        }
}
EMSCRIPTEN_KEEPALIVE void WebTestApproachScenery(s32 kind)
{
    scenery_approach_pending = kind;
}
static void test_approach_scenery(void)
{
    s32 kind = scenery_approach_pending;
    scenery_approach_pending = 0;
    Car* car = GameInfo.players[0].car;
    if (!kind || !car)
        return;
    MATRIX placement;
    IdentifyMatrix(&placement);
    s32 found = 0;
    if (kind == 1) {
        s32* count = RegGetFileDataS("/world/collisionPolys/numCollideInList");
        if (count)
            for (s32 i = 0; i < *count && !found; ++i) {
                Tm4CollisionPolygon* polygon = &WorldCollisionPolygons[i];
                if (!polygon->owner || strcmp(ObjectGetHeader(polygon->owner)->name, "conveyer"))
                    continue;
                s32 n = CollisionPolygonVertexCount(polygon);
                for (s32 j = 0; j < n; ++j) {
                    placement.t[0] += polygon->vertices[j].vx;
                    placement.t[1] += polygon->vertices[j].vy;
                    placement.t[2] += polygon->vertices[j].vz;
                }
                for (s32 axis = 0; axis < 3; ++axis)
                    placement.t[axis] /= n;
                placement.t[1] -= 100;
                found = 1;
            }
    } else {
        for (s32 list = 0; list < OBJECT_LIST_COUNT && !found; ++list)
            for (Tm4ObjectHeader* h = ObjectLists[list].first; h && !found; h = h->next)
                if (!strcmp(h->name, "jumbotron")) {
                    placement.t[0] = h->position.vx;
                    placement.m[0][0] = -ONE;
                    placement.m[2][2] = -ONE;
                    placement.t[1] = h->position.vy + 500;
                    placement.t[2] = h->position.vz + 2000;
                    found = 1;
                }
    }
    if (found) {
        CarOrientWithMatrix(car, &placement);
        Camera* camera = GameInfo.players[0].camera;
        if (camera && camera->object == car) {
            ((CarCameraState*)camera->data)->snap = 1;
            if (kind == 2) {
                scenery_camera = placement;
                scenery_camera.t[1] -= 500;
                camera->process = test_scenery_camera;
            }
        }
        EM_ASM(
            { tm4Port.testSceneryPlaced = ([ $0, $1, $2 ]); }, placement.t[0], placement.t[1],
            placement.t[2]);
    }
}

/* Read-only state for exercising energy actions through ordinary controller input. */
EMSCRIPTEN_KEEPALIVE void WebTestReadEnergyActions(void)
{
    Car* car = GameInfo.players[0].car;
    if (!car)
        return;
    EM_ASM(
        {
            tm4Port.energyAction = ({
                energy : $0,
                maximum : $1,
                shield : $2,
                invisible : $3,
                hidden : !!$4,
                freeze : $5,
                copiedFaces : !!$6,
                copiedColors : !!$7,
                faces : $8,
                colors : $9,
                y : $10,
                velocityY : $11,
                weapons : [],
                objects : []
            });
        },
        car->energy, car->maximum_energy, car->shield_ticks, car->invisibility_ticks,
        car->invisibility_hidden, car->freeze_ticks, car->original_faces, car->original_colors,
        car->faces, car->colors, car->transform.t[1], car->particles[0].velocity_q12.vy);
    if (test_weapon_target && GameIsCarRegistered(test_weapon_target)) {
        EM_ASM(
            {
                tm4Port.energyAction.target = ({
                    freeze : $0,
                    copiedFaces : !!$1,
                    throttle : $2,
                    faces : $3,
                    x : $4,
                    y : $5,
                    z : $6,
                    centerY : $7,
                    headerY : $8
                });
            },
            test_weapon_target->freeze_ticks, test_weapon_target->original_faces,
            test_weapon_target->controls.throttle_input, test_weapon_target->faces,
            test_weapon_target->transform.t[0], test_weapon_target->transform.t[1],
            test_weapon_target->transform.t[2], test_weapon_target->collision_box.center.vy,
            ObjectGetHeader(test_weapon_target)->position.vy);
    }
    for (s32 i = 0; i < 20; ++i) {
        CarWeaponInstance* weapon = &car->weapons[i];
        EM_ASM(
            { tm4Port.energyAction.weapons.push({ amount : $0, nextTime : $1 }); }, weapon->amount,
            weapon->next_time);
    }
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next) {
            if (header->owner != car)
                continue;
            EM_ASM({ tm4Port.energyAction.objects.push(UTF8ToString($0)); }, header->name);
        }
    }
}

/* Sample the real projectile velocity; the test detects its reflection at a surface. */
EMSCRIPTEN_KEEPALIVE void WebTestReadRicochet(void)
{
    EM_ASM({ tm4Port.ricochet = null; });
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next) {
            if (strcmp(header->name, CarTextWeaponProjectile))
                continue;
            WeaponProjectile* projectile = ObjectGetPayload(header);
            if (projectile->owner != GameInfo.players[0].car
                || strcmp(projectile->type->name, "Ricochet"))
                continue;
            EM_ASM(
                { tm4Port.ricochet = ({ age : $0, vx : $1, vy : $2, vz : $3 }); },
                projectile->age_frames, projectile->bullet.motion.fields.world_velocity.vx,
                projectile->bullet.motion.fields.world_velocity.vy,
                projectile->bullet.motion.fields.world_velocity.vz);
            return;
        }
    }
}

EMSCRIPTEN_KEEPALIVE long WebTestSquareRoot0(long value)
{
    return SquareRoot0(value);
}

EMSCRIPTEN_KEEPALIVE u32 WebTestSquareRootInt32(u32 value)
{
    return SquareRootInt32(value);
}

EMSCRIPTEN_KEEPALIVE u32 WebTestSquareRoot64Shifted(u32 high, u32 low, s32 shift)
{
    return SquareRoot64Shifted(high, low, shift);
}

static s32 coop_rules_pending = -1;
static s32 coop_damage_pending = -1;

EMSCRIPTEN_KEEPALIVE s32 WebTestCoopSetup(s32 shared)
{
    if (GameInfo.player_count != 2)
        return 0;
    coop_rules_pending = !!shared;
    return 1;
}

EMSCRIPTEN_KEEPALIVE void WebTestCoopDamage(s32 player)
{
    if (player >= 0 && player < GameInfo.player_count)
        coop_damage_pending = player;
}

static void test_coop_actions(void)
{
    if (coop_rules_pending >= 0) {
        GameInfo.shared_lives = coop_rules_pending;
        GameInfo.players[0].lives = 0;
        GameInfo.players[1].lives = 1;
        coop_rules_pending = -1;
        for (s32 i = 0; i < GameInfo.car_count; ++i) {
            Car* car = GameInfo.cars[i];
            if (car->control_kind == CAR_CONTROL_ENEMY) {
                CarAiProcessFunctionDisable(car);
                memset(&car->controls, 0, sizeof(car->controls));
            }
        }
    }
    if (coop_damage_pending >= 0) {
        Car* car = GameInfo.players[coop_damage_pending].car;
        coop_damage_pending = -1;
        if (car) {
            car->shield_ticks = 0;
            CarApplyDamage(car, NULL, 0x7fffffff, NULL, "COOP TEST");
        }
    }
}

EMSCRIPTEN_KEEPALIVE void WebTestReadCoop(void)
{
    EM_ASM(
        { tm4Port.coop = ({ shared : $0, lost : $1, players : [] }); }, GameInfo.shared_lives,
        GameInfo.world_lost);
    for (s32 i = 0; i < GameInfo.player_count; ++i) {
        Car* car = GameInfo.players[i].car;
        Camera* camera = GameInfo.players[i].camera;
        EM_ASM(
            {
                tm4Port.coop.players.push({
                    alive : !!$0,
                    lives : $1,
                    eliminated : !!$2,
                    camera : !!$3,
                    attached : !!$4
                });
            },
            car != NULL, GameInfo.players[i].lives, GameInfo.players[i].eliminated, camera != NULL,
            car && camera && camera->object == car);
    }
}

static int test_preview_angle = -1;

EMSCRIPTEN_KEEPALIVE void WebTestSetPreviewAngle(int angle)
{
    test_preview_angle = angle;
}

void WebTestDrawMenu(MenuGraphics* graphics)
{
    s32 original_angle = MenuPreviewRotationAngle;
    int preview_angle = test_preview_angle;
    if (preview_angle >= 0)
        MenuPreviewRotationAngle = preview_angle;
    MenuDrawScreen(graphics);
    if (preview_angle >= 0)
        MenuPreviewRotationAngle = original_angle;
    EM_ASM(
        {
            tm4Port.testPreviewAngle = $0;
            tm4Port.previewRotationAngle = $1;
        },
        preview_angle, MenuPreviewRotationAngle);
}
