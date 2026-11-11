#include "src/modules/power/private.h"
#include "../overlays.h"
#include "tm4/gpu.h"
#include "port/web/browser_report.h"
#include <string.h>

void PowerupClassConstructor(RegistryDirectory*);
void PowerupClassDestructor(RegistryDirectory* directory);
s32 PowerupConstructor(PowerupState*, va_list);
s32 PowerupInstanceConstructor(PowerupState*, RegistryDirectory*);
void PowerupProcess(PowerupState*);
void PowerupDisplay(PowerupState*, Tm4OrderingTag*, u8**, u8*, MATRIX*);

static void construct_class(RegistryDirectory* directory)
{
    OSRegisterCarWeapon();
    OSRegisterAi();
    OSRegisterCarPhysics();
    PowerupClassConstructor(directory);
}
static s32 construct(void* object, va_list args)
{
    return PowerupConstructor(object, args);
}
static s32 instance(void* object, RegistryDirectory* directory)
{
    s32 result = PowerupInstanceConstructor(object, directory);
    if (result)
        WEB_BROWSER_REPORT({ tm4Port.pickupInstances = (tm4Port.pickupInstances || 0) + 1; });
    return result;
}
static void process(void* object)
{
    PowerupState* power = object;
    int was_active = power->position.fields.active;
    PowerupProcess(power);
    if (!was_active && power->position.fields.active)
        WEB_BROWSER_REPORT({ tm4Port.pickupRespawns = (tm4Port.pickupRespawns || 0) + 1; });
}
static void display(void* object, Tm4OrderingTag* ot, u8** out, u8* end, MATRIX* camera)
{
    u8* start = *out;
    PowerupDisplay(object, ot, out, end, camera);
    if (*out != start)
        WEB_BROWSER_REPORT({ tm4Port.pickupDraws = (tm4Port.pickupDraws || 0) + 1; });
}
static void destroy_class(RegistryDirectory* directory)
{
    PowerupClassDestructor(directory);
}

OSWord WebPowerExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("PowerupClassConstructor", construct_class);
    EXPORT("PowerupClassDestructor", destroy_class);
    EXPORT("PowerupConstructor", construct);
    EXPORT("PowerupInstanceConstructor", instance);
    EXPORT("PowerupProcess", process);
    EXPORT("PowerupDisplay", display);
    EXPORT("InteractCarWithPowerup", WebInteractCarWithPowerup);
#undef EXPORT
    return 0;
}
