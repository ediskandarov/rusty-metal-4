#include "src/modules/afc/private.h"
#include "../overlays.h"
#include "tm4/gpu.h"
#include <emscripten.h>
#include <string.h>
void AfcClassConstructor(RegistryDirectory*);
s32 AfcConstructor(Afc*, va_list);
s32 AfcInstanceConstructor(Afc*, RegistryDirectory*);
void AfcDisplay(void*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
extern u32 AfcSizeof;
static s32 construct(void* object, va_list args)
{
    s32 result = AfcConstructor(object, args);
    if (result)
        EM_ASM({ tm4Port.flareSpawns = (tm4Port.flareSpawns || 0) + 1; });
    return result;
}
static s32 instance(void* object, RegistryDirectory* directory)
{
    return AfcInstanceConstructor(object, directory);
}
static void display(void* object, Tm4OrderingTag* ot, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
    AfcDisplay(object, ot, output, end, view);
    if (start != *output)
        EM_ASM({ tm4Port.flareDraws = (tm4Port.flareDraws || 0) + 1; });
}
OSWord WebAfcExport(const char* name)
{
#define EXPORT(symbol, value)                                                                      \
    if (!strcmp(name, symbol))                                                                     \
    return (OSWord)(value)
    EXPORT("AfcConstructor", construct);
    EXPORT("AfcInstanceConstructor", instance);
    EXPORT("AfcDisplay", display);
#undef EXPORT
    return 0;
}
