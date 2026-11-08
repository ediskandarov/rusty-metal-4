#include "tm4/modules/jumppad.h"
#include "../overlays.h"
#include <emscripten.h>
#include <string.h>

static s32 construct(void* object, va_list arguments)
{
    return JumppadConstructor(object, arguments);
}
static s32 instance(void* object, RegistryDirectory* directory)
{
    s32 result = JumppadInstanceConstructor(object, directory);
    if (result)
        EM_ASM({ tm4Port.jumppadInstances = (tm4Port.jumppadInstances || 0) + 1; });
    return result;
}
static void process(void* object)
{
    JumppadProcess(object);
}
static void destroy(void* object)
{
    JumppadDestructor(object);
    EM_ASM({ tm4Port.jumppadRemoved = (tm4Port.jumppadRemoved || 0) + 1; });
}
OSWord WebJumppadExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("JumppadConstructor", construct);
    EXPORT("JumppadInstanceConstructor", instance);
    EXPORT("JumppadProcess", process);
    EXPORT("JumppadDestructor", destroy);
#undef EXPORT
    return 0;
}
