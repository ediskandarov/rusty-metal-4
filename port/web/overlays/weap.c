#include "src/modules/weap/private.h"
#include "../overlays.h"
#include "tm4/gpu.h"
#include "tm4/main/game.h"
#include "port/web/browser_report.h"
#include <string.h>
#include <strings.h>
void WeaponBombClassConstructor(RegistryDirectory* directory);
void WeaponBombClassDestructor(RegistryDirectory* directory);
s32 WeaponBombInstanceConstructor(WeaponBomb* bomb, RegistryDirectory* directory);
s32 WeaponBombConstructor(WeaponBomb* bomb, va_list arguments);
void WeaponBombDestructor(WeaponBomb* bomb);
void WeaponBombProcess(WeaponBomb* bomb);
void WeaponBombDisplay(
    WeaponBomb* object, Tm4OrderingTag* ordering, u8** cursor, u8* limit, MATRIX* view);
void BladeProjectileDisplay(WeaponProjectile* projectile, Tm4OrderingTag* ordering, u8** cursor,
    u8* limit, MATRIX* world_to_camera);
void SkullProjectileDisplay(WeaponProjectile* projectile, Tm4OrderingTag* ordering, u8** cursor,
    u8* limit, MATRIX* world_to_camera);
void FunnyProjectileOnDestroy(WeaponProjectile* projectile);
void DetnoProjectileOnDestroy(WeaponProjectile* projectile);
void NukeProjectileOnDestroy(WeaponProjectile* projectile);
void MIRVProjectilePhysics(WeaponProjectile* projectile);
void AutolobProjectilePhysics(WeaponProjectile* projectile);
void Rain2ProjectilePhysics(WeaponProjectile* projectile);
void SkullProjectilePhysics(WeaponProjectile* arg);
void TeleorbProjectilePhysics(WeaponProjectile* projectile);
void Quasar1ProjectilePhysics(WeaponProjectile* projectile);
void Quasar2ProjectilePhysics(WeaponProjectile* projectile);
void Quasar3ProjectilePhysics(WeaponProjectile* projectile);
void HenchProjectilePhysics(WeaponProjectile* projectile);
void Hench1ProjectilePhysics(WeaponProjectile* projectile);
void Hench2ProjectilePhysics(WeaponProjectile* projectile);
void Hench3ProjectilePhysics(WeaponProjectile* projectile);
void RainProjectilePhysics(WeaponProjectile* projectile);
void RicochetProjectilePhysics(WeaponProjectile* projectile);
s32 WeaponProjectileConstructor(WeaponProjectile* projectile, va_list arguments);
void WeaponProjectileDestructor(WeaponProjectile* projectile);
void WeaponProjectileProcess(WeaponProjectile* projectile);
void WeaponProjectileDisplay(WeaponProjectile* projectile, Tm4OrderingTag* ordering, u8** cursor,
    u8* limit, MATRIX* world_to_camera);
void WeaponClassConstructor(RegistryDirectory* directory);
void WeaponProjectileClassConstructor(RegistryDirectory* directory);
void WeaponProjectileClassDestructor(RegistryDirectory* directory);
void OSRegisterSoundEmitter(void);
void OSRegisterBullet(void);
void OSRegisterCarWeapon(void);
void OSRegisterBuildMatrixFunc(void);
void OSRegisterAi(void);
void OSRegisterCarAi(void);
void OSRegisterCarPhysics(void);
void OSRegisterCarDisplay(void);
void OSRegisterCar(void);
void OSRegisterAnimInfo(void);
void OSRegisterExplosion(void);
void OSRegisterafcStuff(void);
void OSRegisterPowerup(void);
extern u32 WeaponProjectileSizeof;
static void construct_class(RegistryDirectory* directory)
{
    OSRegisterSoundEmitter();
    OSRegisterBullet();
    OSRegisterCarWeapon();
    OSRegisterBuildMatrixFunc();
    OSRegisterAi();
    OSRegisterCarAi();
    OSRegisterCarPhysics();
    OSRegisterCarDisplay();
    OSRegisterCar();
    OSRegisterAnimInfo();
    OSRegisterExplosion();
    OSRegisterafcStuff();
    OSRegisterPowerup();
    WeapImports.interact_car_with_anim_fire = OSSymbolGetAddressAssert("InteractCarWithAnim_fire");
    WeapImports.interact_with_flammable_terrain_poly
        = OSSymbolGetAddressAssert("InteractWithFlammableTerrainPoly");
    WeaponClassConstructor(directory);
}
static s32 construct(void* object, va_list args)
{
    s32 result = WeaponProjectileConstructor(object, args);
    if (result) {
        WeaponProjectile* projectile = object;
        WEB_BROWSER_REPORT(
            {
                tm4Port.projectileSpawns = (tm4Port.projectileSpawns || 0) + 1;
                tm4Port.lastProjectile = UTF8ToString($0);
                if ($1) {
                    if (!tm4Port.playerProjectileSpawns)
                        tm4Port.playerProjectileSpawns = ({});
                    const counts = tm4Port.playerProjectileSpawns;
                    const name = UTF8ToString($0);
                    counts[name] = (counts[name] || 0) + 1;
                }
            },
            projectile->type->name, projectile->owner == GameInfo.players[0].car);
    }
    return result;
}
static void process(void* object)
{
    WeaponProjectile* projectile = object;
    if (projectile->bullet.hit_pending || projectile->bullet.motion.fields.world_impact)
        WEB_BROWSER_REPORT({ tm4Port.projectileImpacts = (tm4Port.projectileImpacts || 0) + 1; });
    WeaponProjectileProcess(object);
}
static void destroy(void* object)
{
    WeaponProjectile* projectile = object;
    const char* name = projectile->type->name;
    int player_owned = projectile->owner == GameInfo.players[0].car;
    WeaponProjectileDestructor(object);
    WEB_BROWSER_REPORT(
        {
            tm4Port.projectileRemoved = (tm4Port.projectileRemoved || 0) + 1;
            if ($1) {
                if (!tm4Port.playerProjectileRemoved)
                    tm4Port.playerProjectileRemoved = ({});
                const counts = tm4Port.playerProjectileRemoved;
                const name = UTF8ToString($0);
                counts[name] = (counts[name] || 0) + 1;
            }
        },
        name, player_owned);
}
static void display(void* object, Tm4OrderingTag* ordering, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
    WeaponProjectileDisplay(object, ordering, output, end, view);
    if (start != *output)
        WEB_BROWSER_REPORT({ tm4Port.projectileDraws = (tm4Port.projectileDraws || 0) + 1; });
}
static void display_blade(
    void* object, Tm4OrderingTag* ordering, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
    BladeProjectileDisplay(object, ordering, output, end, view);
    if (*output != start)
        WEB_BROWSER_REPORT({ tm4Port.bladeDraws = (tm4Port.bladeDraws || 0) + 1; });
}
static void destroy_class(RegistryDirectory* directory)
{
    WeaponProjectileClassDestructor(directory);
}
extern u32 WeaponBombSizeof;
static s32 construct_bomb(void* object, va_list args)
{
    s32 result = WeaponBombConstructor(object, args);
    if (result) {
        WeaponBomb* bomb = object;
        WEB_BROWSER_REPORT(
            {
                tm4Port.bombSpawns = (tm4Port.bombSpawns || 0) + 1;
                tm4Port.lastBomb = UTF8ToString($0);
            },
            bomb->type->name);
    }
    return result;
}
static void display_bomb(void* object, Tm4OrderingTag* ordering, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
    WeaponBombDisplay(object, ordering, output, end, view);
    if (start != *output)
        WEB_BROWSER_REPORT({ tm4Port.bombDraws = (tm4Port.bombDraws || 0) + 1; });
}
static void destroy_bomb(void* object)
{
    WeaponBombDestructor(object);
    WEB_BROWSER_REPORT({ tm4Port.bombRemoved = (tm4Port.bombRemoved || 0) + 1; });
}
static void destroy_bomb_class(RegistryDirectory* directory)
{
    WeaponBombClassDestructor(directory);
}
/* Bullet dispatch supplies a hit position and ignores the legacy return value. */
static s32 damage_bomb(void* object, s32 damage, SVECTOR* hit)
{
    return WeaponBombApplyDamage(object, damage, hit);
}
s32 WeaponFireballConstructor(WeaponFireball* fireball, va_list arguments);
void WeaponFireballDestructor(WeaponFireball* fireball);
void WeaponFireballDisplay(void*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
static s32 construct_fireball(void* object, va_list arguments)
{
    s32 result = WeaponFireballConstructor(object, arguments);
    if (result)
        WEB_BROWSER_REPORT({ tm4Port.fireballSpawns = (tm4Port.fireballSpawns || 0) + 1; });
    return result;
}
static void destroy_fireball(void* object)
{
    WeaponFireballDestructor(object);
    WEB_BROWSER_REPORT({ tm4Port.fireballRemoved = (tm4Port.fireballRemoved || 0) + 1; });
}
static void display_fireball(
    void* object, Tm4OrderingTag* ordering, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
    WeaponFireballDisplay(object, ordering, output, end, view);
    if (start != *output)
        WEB_BROWSER_REPORT({ tm4Port.fireballDraws = (tm4Port.fireballDraws || 0) + 1; });
}
extern CVECTOR worldWeaponColor;
OSWord WebWeaponExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcasecmp(name, key))                                                                    \
    return (OSWord)(value)
    EXPORT("WeaponClassConstructor", construct_class);
    EXPORT("WeaponFireballConstructor", construct_fireball);
    EXPORT("WeaponFireballDestructor", destroy_fireball);
    EXPORT("WeaponFireballDisplay", display_fireball);
    EXPORT("WeaponBombClassDestructor", destroy_bomb_class);
    EXPORT("WeaponBombConstructor", construct_bomb);
    EXPORT("WeaponBombDestructor", destroy_bomb);
    EXPORT("WeaponBombDisplay", display_bomb);
    EXPORT("WeaponBombApplyDamage", damage_bomb);
    EXPORT("WeaponProjectileClassDestructor", destroy_class);
    EXPORT("WeaponProjectileConstructor", construct);
    EXPORT("WeaponProjectileProcess", process);
    EXPORT("WeaponProjectileDestructor", destroy);
    EXPORT("WeaponProjectileDisplay", display);
    EXPORT("BladeProjectileDisplay", display_blade);
    EXPORT("HenchProjectilePhysics", HenchProjectilePhysics);

#undef EXPORT
    return 0;
}
