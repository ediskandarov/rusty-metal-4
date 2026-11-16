#include "../overlays.h"
#include "port/web/browser_report.h"
#include "port/web/module_import.h"
#include "src/modules/anim/private.h"
#include "tm4/gpu.h"
#include <string.h>
void AnimClassConstructor(RegistryDirectory*);
void InteractCarWithAnim_goggle(Car*, Anim*);
void AnimClassDestructor(RegistryDirectory* directory);
s32 AnimConstructor(Anim*, va_list);
void AnimProcess(Anim*);
void AnimDestructor(Anim*);
void AnimDisplay(void*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
extern u32 AnimSizeof;
static s32 construct(void* object, va_list args)
{
    s32 result = AnimConstructor(object, args);
    if (result)
        WEB_BROWSER_REPORT({ tm4Port.animSpawns = (tm4Port.animSpawns || 0) + 1; });
    return result;
}
static void process(void* object) { AnimProcess(object); }
static void destroy(void* object) { AnimDestructor(object); }
static void display(void* object, Tm4OrderingTag* ordering, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
    AnimDisplay(object, ordering, output, end, view);
    if (*output != start)
        WEB_BROWSER_REPORT({ tm4Port.animDraws = (tm4Port.animDraws || 0) + 1; });
}
static void goggle_contact(Car* car, Anim* animation)
{
    s32 health = car->health;
    InteractCarWithAnim_goggle(car, animation);
    if (car->health < health)
        WEB_BROWSER_REPORT(
            { tm4Port.flameDamage = (tm4Port.flameDamage || 0) + $0; }, health - car->health);
}

OSWord WebAnimExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("AnimClassConstructor", AnimClassConstructor);
    EXPORT("AnimClassDestructor", AnimClassDestructor);
    EXPORT("AnimConstructor", construct);
    EXPORT("AnimProcess", process);
    EXPORT("AnimDestructor", destroy);
    EXPORT("AnimDisplay", display);
    if (!strcmp(name, "InteractCarWithAnim_goggle")) {
        Import_CarApplyParticipantDamage = WEB_MODULE("car", CarApplyParticipantDamage);
        Import_InteractCarWithAnim_fire = OSSymbolGetAddressAssert("InteractCarWithAnim_fire");
        return (OSWord)goggle_contact;
    }
#undef EXPORT
    return 0;
}
