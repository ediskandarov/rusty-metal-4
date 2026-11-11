#include "src/modules/frag/private.h"
#include "../overlays.h"
#include "tm4/main/os.h"
#include "port/web/browser_report.h"
#include <string.h>

s32 FragmentConstructor(Fragment*, va_list);
void FragmentProcess(Fragment*);
void FragmentDisplay(Fragment*, Tm4OrderingTag*, u8**, u8*, MATRIX*);

static s32 construct(void* object, va_list arguments)
{
    Import_G = OSSymbolGetAddressAssert("G");
    Import_SpawnExplosion = SpawnExplosion;
    s32 result = FragmentConstructor(object, arguments);
    if (result)
        WEB_BROWSER_REPORT({ tm4Port.fragmentSpawns = (tm4Port.fragmentSpawns || 0) + 1; });
    return result;
}
static void process(void* object)
{
    FragmentProcess(object);
}
static void display(void* object, Tm4OrderingTag* ordering, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
    FragmentDisplay(object, ordering, output, end, view);
    if (*output != start)
        WEB_BROWSER_REPORT({ tm4Port.fragmentDraws = (tm4Port.fragmentDraws || 0) + 1; });
}
OSWord WebFragmentExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("FragmentConstructor", construct);
    EXPORT("FragmentProcess", process);
    EXPORT("FragmentDisplay", display);
#undef EXPORT
    return 0;
}
