#include "src/modules/fire/private.h"
#include "../overlays.h"
#include "port/web/browser_report.h"
#include <string.h>

void FlameEmitterClassConstructor(RegistryDirectory*);
void FlameEmitterClassDestructor(RegistryDirectory*);
s32 FlameEmitterConstructor(FlameEmitter*, va_list);
s32 FlameEmitterInstanceConstructor(FlameEmitter*, RegistryDirectory*);
void FlameEmitterProcess(FlameEmitter*);

static void construct_class(RegistryDirectory* directory)
{
    OSRegisterSoundEmitter();
    OSRegisterCarPhysics();
    FlameEmitterClassConstructor(directory);
}
static s32 construct(void* object, va_list arguments)
{
    s32 result = FlameEmitterConstructor(object, arguments);
    if (result)
        WEB_BROWSER_REPORT({ tm4Port.flameSpawns = (tm4Port.flameSpawns || 0) + 1; });
    return result;
}
static void process(void* object)
{
    FlameEmitterProcess(object);
}
OSWord WebFireExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("FlameEmitterClassConstructor", construct_class);
    EXPORT("FlameEmitterConstructor", construct);
    EXPORT("FlameEmitterProcess", process);
#undef EXPORT
    return 0;
}
