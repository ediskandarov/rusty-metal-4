#include "src/modules/lightn/private.h"
#include "../overlays.h"
#include "tm4/main/screen.h"
#include "port/web/browser_report.h"
#include <string.h>

void WeaponLightningEmitterClassConstructor(RegistryDirectory*);
void WeaponLightningEmitterClassDestructor(RegistryDirectory*);
s32 WeaponLightningEmitterConstructor(LightningEmitter*, va_list);
s32 WeaponLightningEmitterInstanceConstructor(LightningEmitter*, RegistryDirectory*);
void WeaponLightningEmitterProcess(LightningEmitter*);
void WeaponLightningEmitterDestructor(LightningEmitter*);
void WeaponLightningEmitterDisplay(void*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
s32 WeaponLightningConstructor(Lightning*, va_list);
void WeaponLightningProcess(Lightning*);
void WeaponLightningDisplay(Lightning*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
extern u32 WeaponLightningSizeof, WeaponLightningEmitterSizeof;

static void construct_class(RegistryDirectory* directory)
{
    OSRegisterCarPhysics();
    WeaponLightningEmitterClassConstructor(directory);
}
static s32 construct_emitter(void* object, va_list arguments)
{
    s32 result = WeaponLightningEmitterConstructor(object, arguments);
    if (result)
        WEB_BROWSER_REPORT({ tm4Port.lightningEmitters = (tm4Port.lightningEmitters || 0) + 1; });
    return result;
}
static s32 instance_emitter(void* object, RegistryDirectory* directory)
{
    return WeaponLightningEmitterInstanceConstructor(object, directory);
}
static void process_emitter(void* object)
{
    WeaponLightningEmitterProcess(object);
    WEB_BROWSER_REPORT({ tm4Port.lightningFlashActive = !!$0; }, g_specialEffect);
    if (g_specialEffect)
        WEB_BROWSER_REPORT({ tm4Port.lightningFlashes = (tm4Port.lightningFlashes || 0) + 1; });
}
static void destroy_emitter(void* object)
{
    WeaponLightningEmitterDestructor(object);
    WEB_BROWSER_REPORT(
        {
            tm4Port.lightningRemoved = (tm4Port.lightningRemoved || 0) + 1;
            tm4Port.lightningFlashActive = !!$0;
        },
        g_specialEffect);
}
static s32 construct_bolt(void* object, va_list arguments)
{
    s32 result = WeaponLightningConstructor(object, arguments);
    if (result)
        WEB_BROWSER_REPORT({ tm4Port.lightningBolts = (tm4Port.lightningBolts || 0) + 1; });
    return result;
}
static void process_bolt(void* object)
{
    Lightning* bolt = object;
    Car* target = bolt->target;
    s32 health = target && GameIsCarRegistered(target) ? target->health : 0;
    WeaponLightningProcess(bolt);
    if (target && GameIsCarRegistered(target) && target->health < health)
        WEB_BROWSER_REPORT(
            { tm4Port.lightningDamage = (tm4Port.lightningDamage || 0) + $0; },
            health - target->health);
}
static void display_bolt(void* object, Tm4OrderingTag* ordering, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
    WeaponLightningDisplay(object, ordering, output, end, view);
    if (*output != start)
        WEB_BROWSER_REPORT({ tm4Port.lightningDraws = (tm4Port.lightningDraws || 0) + 1; });
}
OSWord WebLightningExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("WeaponLightningEmitterClassConstructor", construct_class);
    EXPORT("WeaponLightningEmitterConstructor", construct_emitter);
    EXPORT("WeaponLightningEmitterInstanceConstructor", instance_emitter);
    EXPORT("WeaponLightningEmitterProcess", process_emitter);
    EXPORT("WeaponLightningEmitterDestructor", destroy_emitter);
    EXPORT("WeaponLightningConstructor", construct_bolt);
    EXPORT("WeaponLightningProcess", process_bolt);
    EXPORT("WeaponLightningDisplay", display_bolt);
#undef EXPORT
    return 0;
}
