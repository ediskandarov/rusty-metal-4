#include "src/modules/destry/private.h"
#include "../overlays.h"
#include "tm4/main/object.h"
#include <emscripten.h>
#include <string.h>

static void bind_imports(void)
{
    OSRegisterAi();
    OSRegisterExplosion();
}
static s32 construct(void* object, va_list arguments)
{
    bind_imports();
    return DestroyableConstructor(object, arguments);
}
static s32 instance(void* object, RegistryDirectory* directory)
{
    bind_imports();
    s32 result = DestroyableInstanceConstructor(object, directory);
    if (result)
        EM_ASM({ tm4Port.destroyableInstances = (tm4Port.destroyableInstances || 0) + 1; });
    return result;
}
static void process(void* object)
{
    DestroyableProcess(object);
}
static void destroy(void* object)
{
    DestroyableDestructor(object);
}
static s32 damage(Destroyable* object, s32 amount, s32 x, s32 y, s32 z)
{
    s32 health = object->hit_points;
    s32 serial = ObjectGetHeader(object)->serial;
    char* name = RegGetDirectoryNameP(object->registry);
    s32 result = DestroyableApplyDamage(object, amount, x, y, z);
    EM_ASM(
        {
            tm4Port.destroyableHits = (tm4Port.destroyableHits || 0) + 1;
            tm4Port.lastDestroyableHit = ({
                serial : $0,
                name : UTF8ToString($1),
                health : $2,
                damage : $3,
                survived : $4
            });
            if (!$4)
                tm4Port.destroyedObjects = (tm4Port.destroyedObjects || 0) + 1;
        },
        serial, name, health, amount, result);
    return result;
}
OSWord WebDestroyableExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("DestroyableConstructor", construct);
    EXPORT("DestroyableInstanceConstructor", instance);
    EXPORT("DestroyableProcess", process);
    EXPORT("DestroyableDestructor", destroy);
    EXPORT("DestroyableApplyDamage", damage);
#undef EXPORT
    return 0;
}
