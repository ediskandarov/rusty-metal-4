#include "port/web/checkpoint_memory.h"
#include "port/web/net_match.h"
#include "src/main/object/private.h"
#include "src/modules/car/private.h"
#include "src/modules/cars/c_crush/private.h"
#include "src/modules/cars/shovel.h"
#include "src/modules/firing/private.h"
#include "tm4/main/game.h"
#include "tm4/main/object.h"
#include "tm4/modules/anim.h"
#include "tm4/modules/auger.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/interact.h"
#include "tm4/modules/power.h"
#include "tm4/modules/weap.h"
#include "tm4/vector.h"
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

s32 CarLaunchLightning(Car*, void*, CarWeaponInstance*, s32);
static PowerupState* test_pickup;
static s32 test_weapon_index;
static MATRIX test_car_transform;

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

EMSCRIPTEN_KEEPALIVE int WebTestPlacePlayerProjectileTarget(
    s32 source, s32 destination, const char* name)
{
    if ((u32)source >= GameInfo.player_car_count || (u32)destination >= GameInfo.player_car_count
        || source == destination)
        return 0;
    const Car* shooter = GameInfo.players[source].car;
    Car* target = GameInfo.players[destination].car;
    if (!shooter || !target || target->freeze_ticks)
        return 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next) {
            const Bullet* bullet = NULL;
            if (!strcmp(header->name, "bullet") && !strcasecmp(name, "bullet")) {
                if (header->owner != shooter)
                    continue;
                bullet = ObjectGetPayload(header);
                if (bullet->motion.fields.world_impact || bullet->hit_object)
                    continue;
            } else if (!strcmp(header->name, "weaponProjectile")) {
                const WeaponProjectile* projectile = ObjectGetPayload(header);
                if (projectile->owner != shooter || strcasecmp(projectile->type->name, name))
                    continue;
                bullet = &projectile->bullet;
            } else
                continue;
            MATRIX placement;
            IdentifyMatrix(&placement);
            placement.t[0] = bullet->current_world.vx - target->collision_box.center.vx;
            placement.t[1] = bullet->current_world.vy - target->collision_box.center.vy;
            placement.t[2] = bullet->current_world.vz - target->collision_box.center.vz;
            CarOrientWithMatrix(target, &placement);
            ObjectSetPosition(
                target, target->position.vx, target->position.vy, target->position.vz);
            return 1;
        }
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE int WebTestPlaceProjectileTarget(const char* name)
{
    return WebTestPlacePlayerProjectileTarget(0, 1, name);
}

EMSCRIPTEN_KEEPALIVE int WebTestPlacePlayerTarget(
    s32 source, s32 destination, s32 distance, s32 grab)
{
    if ((u32)source >= GameInfo.player_car_count || (u32)destination >= GameInfo.player_car_count
        || source == destination)
        return 0;
    Car* shooter = GameInfo.players[source].car;
    Car* target = GameInfo.players[destination].car;
    if (!shooter || !target)
        return 0;
    s32 offset[3] = { 0, 0, distance };
    if (grab) {
        offset[0] = shooter->collision_box.center.vx - target->collision_box.center.vx;
        offset[1] = shooter->collision_box.center.vy - target->collision_box.center.vy;
        offset[2] = shooter->collision_box.maximum.vz - target->collision_box.minimum.vz - 32;
    }
    MATRIX placement = shooter->transform;
    for (s32 axis = 0; axis < 3; ++axis)
        placement.t[axis] += (shooter->transform.m[axis][0] * offset[0]
                                 + shooter->transform.m[axis][1] * offset[1]
                                 + shooter->transform.m[axis][2] * offset[2])
            >> 12;
    CarOrientWithMatrix(target, &placement);
    ObjectSetPosition(target, target->position.vx, target->position.vy, target->position.vz);
    target->shield_ticks = 0;
    return 1;
}

EMSCRIPTEN_KEEPALIVE int WebTestPreparePlayerDuel(s32 source, s32 destination, s32 distance)
{
    if (!WebTestPlacePlayerTarget(source, destination, distance, 0))
        return 0;
    GameInfo.players[destination].car->health = 1;
    return 1;
}

EMSCRIPTEN_KEEPALIVE void WebTestReadNetworkCombat(void)
{
    u32 objects = 0, projectiles = 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (const Tm4ObjectHeader* object = ObjectLists[list].first; object;
             object = object->next) {
            ++objects;
            projectiles += !strcmp(object->name, "weaponProjectile");
        }
    }
    EM_ASM(
        { tm4Port.testCombatObjects = ({ serial : $0, count : $1, projectiles : $2 }); },
        ObjectNextSerial, objects, projectiles);

    EM_ASM({
        tm4Port.testCombatPlayers = [];
        tm4Port.testWasmBytes = HEAPU8.buffer.byteLength;
    });
    for (s32 i = 0; i < GameInfo.player_car_count; ++i) {
        const Car* car = GameInfo.players[i].car;
        const Car* held = NULL;
        if (car && car->callback_context) {
            if (!strcasecmp(car->filename, "auger"))
                held = ((const AugerDrill*)car->callback_context)->target;
            else if (!strcasecmp(car->filename, "crusher"))
                held = ((const CrusherPinchers*)car->callback_context)->target;
            else if (!strcasecmp(car->filename, "slam") || !strcasecmp(car->filename, "trash"))
                held = ((const CarShovelState*)car->callback_context)->target;
        }
        EM_ASM(
            { tm4Port.testCombatPlayers.push({ health : $0, freeze : $1, held : $2, fire : $3 }); },
            car ? car->health : 0, car ? car->freeze_ticks : 0,
            held && GameIsCarRegistered((Car*)held) ? held->controller_index + 1 : 0,
            car ? car->fire_ticks : 0);
    }
}

EMSCRIPTEN_KEEPALIVE s32 WebTestFrozenFaceTicks(s32 slot)
{
    const Car* car = (u32)slot < ArrayCount(GameInfo.players) ? GameInfo.players[slot].car : NULL;
    return car && car->original_faces ? (car->freeze_ticks ? car->freeze_ticks : -1) : 0;
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

EMSCRIPTEN_KEEPALIVE int WebTestNetworkWallContact(s32 slot)
{
    const Car* car = GameInfo.players[slot].car;
    if (!car)
        return 0;
    for (s32 i = 0; i < ArrayCount(car->particles); ++i) {
        if (car->particles[i].contact_state && abs(car->particles[i].normal.vy) < ONE / 2)
            return 1;
    }
    return 0;
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

/* Use the simulation allocator even though the diagnostic call is between ticks. */
EMSCRIPTEN_KEEPALIVE int WebTestCreateFireRing(s32 terrain)
{
    Car* player = GameInfo.players[0].car;
    if (!player || !WebNetMatchActive())
        return 0;
    WebCheckpointArenaSelect(1);
    int result;
    if (terrain)
        result = WebTestIgniteGround();
    else {
        SVECTOR axis = { 0, ONE, 0, 0 };
        result
            = ObjectCreate("fireRing", 0, "fire", &player->position, 1536, 192, NULL, &axis, 4096)
            != NULL;
    }
    WebCheckpointArenaSelect(0);
    return result;
}

EMSCRIPTEN_KEEPALIVE void WebTestReadFireRings(void)
{
    EM_ASM({ tm4Port.testFireRings = []; });
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next) {
            if (strcmp(header->name, "fireRing"))
                continue;
            const FireRing* ring = ObjectGetPayload(header);
            EM_ASM(
                {
                    tm4Port.testFireRings.push({
                        serial : $0,
                        address : $1,
                        nameAddress : $2,
                        particlesAddress : $3,
                        polygonAddress : $4,
                        particleCount : $5,
                        divisions : $6,
                        radius : $7,
                        polygonIndex : $8,
                        animations : []
                    });
                },
                header->serial, ring, ring->animation_name, ring->particles, ring->polygon,
                ring->particle_count, ring->angular_divisions, ring->radius,
                ring->polygon ? ring->polygon - WorldCollisionPolygons + 1 : 0);
            for (s32 i = 0; i < ring->particle_count; ++i) {
                const Anim* animation = ring->particles[i].animation;
                const Tm4ObjectHeader* child = animation && ObjectValidObject((void*)animation)
                    ? ObjectGetHeader(animation)
                    : NULL;
                EM_ASM(
                    {
                        tm4Port.testFireRings.at(-1).animations.push(
                            { serial : $0, address : $1, owned : !!$2 });
                    },
                    child ? child->serial : -1, animation,
                    child && child->owner == ring && (child->flags & OBJECT_DESTROY_WITH_OWNER));
            }
        }
    }
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
    } else if (!strcasecmp(car->filename, "auger")) {
        AugerDrill* drill = car->callback_context;
        target = drill->target;
        angle = drill->angle;
        remaining = drill->active_ticks;
        sound = drill->loop_sound;
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
