#include "src/modules/interact/private.h"
#include "../overlays.h"
#include "tm4/main/game.h"
#include "tm4/modules/bullet.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/car.h"
#include "tm4/modules/ray.h"
#include "port/web/browser_report.h"
#include "port/web/net_match.h"
#include <string.h>
void InteractCarWithBullet(Car* car, Bullet* bullet);
void InteractCarWithAnim(Car*, Anim*);
void InteractWeaponRayBeamWithWeaponBomb(RayBeam*, WeaponBomb*);
void WebInteractCarWithBullet(void* car, void* bullet)
{
    InteractCarWithBullet(car, bullet);
}

void InteractCarWithPowerup(Car*, PowerupState*);
void WebInteractCarWithPowerup(void* car, void* object)
{
    PowerupState* power = object;
    int was_active = power->position.fields.active;
    Import_PowerupSparkleConstructor = PowerupSparkleConstructor;
    InteractCarWithPowerup(car, power);
    if (was_active && !power->position.fields.active)
        WEB_BROWSER_REPORT({ tm4Port.pickupCollections = (tm4Port.pickupCollections || 0) + 1; });
}

void InteractCarWithWeaponProjectile(Car*, WeaponProjectile*);
void WebInteractCarWithWeaponProjectile(void* car, void* projectile)
{
    InteractCarWithWeaponProjectile(car, projectile);
}
void InteractCarWithAnim_fire(Car*, Anim*);
void InteractWithFlammableTerrainPoly(Tm4CollisionPolygon*, SVECTOR*);
static void car_shockwave(Car* car, ExplosionWave* wave)
{
    s32 health = car->health;
    InteractCarWithExplosionShockWave(car, wave);
    if (car->health < health)
        WEB_BROWSER_REPORT({ tm4Port.shockwaveCarHits = (tm4Port.shockwaveCarHits || 0) + 1; });
}
static void car_teleporter(void* object, void* portal)
{
    Car* car = object;
    Teleporter* teleporter = portal;
    InteractCarWithTeleporter(car, teleporter);
    Camera* camera = (WebNetMatchActive() ? WebNetSlotOccupied(car->controller_index)
                                        : car->controller_index < GameInfo.player_count)
        ? GameInfo.players[car->controller_index].camera
        : NULL;
    WEB_BROWSER_REPORT(
        {
            tm4Port.teleports = (tm4Port.teleports || 0) + 1;
            tm4Port.lastTeleport = ({
                transformOrigin : [ $0, $1, $2 ],
                destination : [ $3, $4, $5 ],
                cameraSnap : $6,
                player : $7
            });
        },
        car->transform.t[0], car->transform.t[1], car->transform.t[2],
        teleporter->destination_world.vx, teleporter->destination_world.vy,
        teleporter->destination_world.vz,
        camera && camera->object == car ? ((CarCameraState*)camera->data)->snap : -1,
        car == GameInfo.players[0].car);
}
static void car_jumppad(void* object, void* pad)
{
    Car* car = object;
    Tm4VectorXYZ before = car->particles[0].external_force;
    Jumppad* trigger = pad;
    if (car == GameInfo.players[0].car) {
        s32 dot = (s16)(car->position.vx - car->previous_position.vx) * trigger->direction.vx
            + (s16)(car->position.vy - car->previous_position.vy) * trigger->direction.vy
            + (s16)(car->position.vz - car->previous_position.vz) * trigger->direction.vz;
        WEB_BROWSER_REPORT(
            {
                tm4Port.playerJumppadContacts = (tm4Port.playerJumppadContacts || 0) + 1;
                tm4Port.lastJumppadTravelDot = $0;
            },
            dot);
    }
    InteractCarWithJumppad(car, pad);
    Tm4VectorXYZ* after = &car->particles[0].external_force;
    if (before.vx != after->vx || before.vy != after->vy || before.vz != after->vz) {
        if (car == GameInfo.players[0].car)
            WEB_BROWSER_REPORT({ tm4Port.playerJumppadLaunches = (tm4Port.playerJumppadLaunches || 0) + 1; });
        WEB_BROWSER_REPORT(
            {
                tm4Port.jumppadLaunches = (tm4Port.jumppadLaunches || 0) + 1;
                tm4Port.lastJumppadForce = ([ $0, $1, $2 ]);
            },
            after->vx - before.vx, after->vy - before.vy, after->vz - before.vz);
    }
}
static void bullet_destroyable(void* weapon, void* object)
{
    InteractBulletWithDestroyable(weapon, object);
}
static void projectile_destroyable(void* weapon, void* object)
{
    InteractWeaponProjectileWithDestroyable(weapon, object);
}
static void car_destroyable(void* car, void* object)
{
    InteractCarWithDestroyable(car, object);
}
static void wave_destroyable(void* wave, void* object)
{
    InteractExplosionShockWaveWithDestroyable(wave, object);
}
static void ray_destroyable(void* ray, void* object)
{
    InteractWeaponRayBeamWithDestroyable(ray, object);
}
OSWord WebInteractExport(const char* name)
{
    if (strstr(name, "WithDestroyable")) {
        OSRegisterDestroyable();
#define INTERACTION(key, callback)                                                                 \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(callback)
        INTERACTION("InteractBulletWithDestroyable", bullet_destroyable);
        INTERACTION("InteractWeaponProjectileWithDestroyable", projectile_destroyable);
        INTERACTION("InteractCarWithDestroyable", car_destroyable);
        INTERACTION("InteractExplosionShockWaveWithDestroyable", wave_destroyable);
        INTERACTION("InteractWeaponRayBeamWithDestroyable", ray_destroyable);
#undef INTERACTION
    }
    if (!strcmp(name, "InteractCarWithTeleporter")) {
        OSRegisterCarPhysics();
        OSRegisterCarAi();
        return (OSWord)car_teleporter;
    }
    if (!strcmp(name, "InteractCarWithJumppad"))
        return (OSWord)car_jumppad;
    if (!strcmp(name, "InteractCarWithWeaponProjectile"))
        return (OSWord)WebInteractCarWithWeaponProjectile;
    if (!strcmp(name, "InteractCarWithAnim_fire")) {
        Import_CarAiInteractedWithFire = CarAiInteractedWithFire;
        return (OSWord)InteractCarWithAnim_fire;
    }
    if (!strcmp(name, "InteractWithFlammableTerrainPoly"))
        return (OSWord)InteractWithFlammableTerrainPoly;
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    if (!strcmp(name, "BoxObjectApplyDamage")) {
        OSRegisterAi();
        OSRegisterExplosion();
        return (OSWord)BoxObjectApplyDamage;
    }
    if (!strcmp(name, "InteractCarWithExplosionShockWave")) {
        OSRegisterCarPhysics();
        OSRegisterCar();
        OSRegisterCarAi();
        return (OSWord)car_shockwave;
    }
#undef EXPORT
    return 0;
}
