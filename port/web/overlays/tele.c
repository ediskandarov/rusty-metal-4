#include "src/modules/tele/private.h"
#include "../overlays.h"
#include "tm4/main/registry.h"
#include <STDARG.H>
#include <emscripten.h>
#include <string.h>

void TeleporterClassConstructor(RegistryDirectory*);
s32 TeleporterConstructor(Teleporter*, va_list);
s32 TeleporterInstanceConstructor(Teleporter*, RegistryDirectory*);
void TeleporterProcess(Teleporter*);
void TeleporterDisplay(void*, Tm4OrderingTag*, u8**, u8*, MATRIX*);

static s32 construct(void* object, va_list arguments)
{
    return TeleporterConstructor(object, arguments);
}
static s32 instance(void* object, RegistryDirectory* directory)
{
    s32 result = TeleporterInstanceConstructor(object, directory);
    if (result)
        EM_ASM({ tm4Port.teleporterInstances = (tm4Port.teleporterInstances || 0) + 1; });
    return result;
}
static void process(void* object)
{
    TeleporterProcess(object);
}
static void display(void* object, Tm4OrderingTag* ordering, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
    TeleporterDisplay(object, ordering, output, end, view);
    if (*output != start)
        EM_ASM({ tm4Port.teleporterDraws = (tm4Port.teleporterDraws || 0) + 1; });
}
OSWord WebTeleporterExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("TeleporterConstructor", construct);
    EXPORT("TeleporterInstanceConstructor", instance);
    EXPORT("TeleporterProcess", process);
    EXPORT("TeleporterDisplay", display);
#undef EXPORT
    return 0;
}
