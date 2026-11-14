#include "pending.h"
#include "port/web/browser_report.h"
#include "src/modules/car/private.h"
#include "src/modules/levels/w_carni/private.h"
#include "src/modules/levels/w_neon/private.h"
#include "src/modules/levels/w_oil/private.h"
#include "src/modules/levels/w_yard/private.h"
#include "tm4/main/game.h"
#include "tm4/main/object.h"
#include "tm4/main/system.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/conveyer.h"
#include "tm4/modules/destry.h"
#include "tm4/modules/jumbo.h"
#include "tm4/modules/jumppad.h"
#include "tm4/modules/power.h"
#include "tm4/modules/tele.h"
#include "tm4/vector.h"
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

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
        WEB_BROWSER_REPORT(
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
            test_destroyable_polygon ? CollisionPolygonEnabled(test_destroyable_polygon) : 0,
            test_destroyable_polygon && test_destroyable_polygon->owner != NULL, fragments);
    }
    return present;
}

static int test_destroy_map_pending;

EMSCRIPTEN_KEEPALIVE void WebTestDestroyMapScenery(void)
{
    test_destroy_map_pending = 1;
}

static int test_destroy_map_scenery(void)
{
    const s32* count = RegGetFileDataS("/world/collisionPolys/numCollideInList");
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next) {
            if (strcmp(header->name, "destroyable"))
                continue;
            Destroyable* object = ObjectGetPayload(header);
            test_destroyable = object;
            test_destroyable_serial = header->serial;
            test_destroyable_world = object->world;
            test_destroyable_polygon = NULL;
            for (s32 i = 0; count && i < *count; ++i)
                if (WorldCollisionPolygons[i].owner == object) {
                    test_destroyable_polygon = &WorldCollisionPolygons[i];
                    break;
                }
            SVECTOR position;
            ObjectCopyPosition(&position, object);
            return !DestroyableApplyDamage(
                       object, object->hit_points, position.vx, position.vy, position.vz)
                && !WebTestDestroyablePresent();
        }
    }
    return 0;
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
        WEB_BROWSER_REPORT(
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

EMSCRIPTEN_KEEPALIVE int WebTestAimAtWeakDestroyable(void)
{
    if (!WebTestAimAtDestroyable())
        return 0;
    test_destroyable->hit_points = 1;
    return 1;
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
                WEB_BROWSER_REPORT(
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
                if (GameInfo.cars[i] != car
                    && GameInfo.cars[i]->control_kind == CAR_CONTROL_ENEMY) {
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

static int helicopter_projectile_pending;

static Helicopter* test_find_helicopter(void)
{
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list)
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next)
            if (!strcasecmp(header->name, "helicopter") && !header->owner)
                return ObjectGetPayload(header);
    return NULL;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestLaunchAtHelicopter(void)
{
    helicopter_projectile_pending = test_find_helicopter() != NULL;
    return helicopter_projectile_pending;
}

void WebTestApplyHelicopterShot(void)
{
    if (!helicopter_projectile_pending)
        return;
    helicopter_projectile_pending = 0;
    Helicopter* helicopter = test_find_helicopter();
    Car* car = GameInfo.players[0].car;
    if (!helicopter || !car)
        return;
    /* Start behind the bounding box so normal projectile physics delivers the hit. */
    SVECTOR start = helicopter->box.center;
    start.vz = helicopter->box.minimum.vz - 200;
    SVECTOR world_start;
    MATRIX launch = helicopter->path.local_to_world;
    ApplyMatrixWithTranslationSV(&launch, &start, &world_start);
    launch.t[0] = world_start.vx;
    launch.t[1] = world_start.vy;
    launch.t[2] = world_start.vz;
    SVECTOR velocity = { 0 };
    ObjectCreate(CarTextWeaponProjectile, OBJECT_DESTROY_WITH_OWNER, car, CarTextPower, NULL,
        &launch, &velocity);
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

void WebTestApplySceneryActions(void)
{
    test_approach_scenery();
    if (test_destroy_map_pending) {
        test_destroy_map_pending = 0;
        const int destroyed = test_destroy_map_scenery();
        EM_ASM({ tm4Port.testSceneryDamaged = !!$0; }, destroyed);
    }
}
