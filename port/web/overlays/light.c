#include "tm4/modules/light.h"
#include "../overlays.h"
#include "tm4/main/registry.h"
#include "tm4/modules/car.h"
#include <STDARG.H>
#include <emscripten.h>
#include <string.h>

extern u32 LightEmitterSizeof;
s32 LightEmitterConstructor(LightEmitter*, va_list);
s32 LightEmitterInstanceConstructor(LightEmitter*, RegistryDirectory*);
void InteractCarWithLightEmitter(Car*, LightEmitter*);

static s32 construct(void* object, va_list arguments)
{
    s32 result = LightEmitterConstructor(object, arguments);
    if (result)
        EM_ASM({ tm4Port.lightSpawns = (tm4Port.lightSpawns || 0) + 1; });
    return result;
}
static s32 instance(void* object, RegistryDirectory* directory)
{
    return LightEmitterInstanceConstructor(object, directory);
}
static void interact(void* car, void* light)
{
    Car* target = car;
    u32 distances[3];
    for (s32 i = 0; i < 3; ++i)
        distances[i] = target->lights[i].distance_squared;
    InteractCarWithLightEmitter(target, light);
    for (s32 i = 0; i < 3; ++i)
        if (distances[i] != target->lights[i].distance_squared) {
            EM_ASM({ tm4Port.lightCarUpdates = (tm4Port.lightCarUpdates || 0) + 1; });
            break;
        }
    EM_ASM({ tm4Port.lightCarInteractions = (tm4Port.lightCarInteractions || 0) + 1; });
}
OSWord WebLightExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("LightEmitterConstructor", construct);
    EXPORT("LightEmitterInstanceConstructor", instance);
    EXPORT("InteractCarWithLightEmitter", interact);
#undef EXPORT
    return 0;
}
