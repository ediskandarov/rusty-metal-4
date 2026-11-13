#include "src/modules/bullet/private.h"
#include "../overlays.h"
#include "tm4/gpu.h"
#include "port/web/browser_report.h"
#include <string.h>
void BulletClassConstructor(RegistryDirectory*);
s32 BulletConstructor(Bullet*, va_list);
void BulletProcess(Bullet*);
void BulletDisplay(void*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
extern u32 BulletSizeof;

static void construct_class(RegistryDirectory* directory)
{
    Import_CarApplyParticipantDamage = CarApplyParticipantDamage;
    Import_SpawnExplosion = SpawnExplosion;
    BulletClassConstructor(directory);
}
static s32 construct(void* object, va_list args)
{
    s32 result = BulletConstructor(object, args);
    if (result)
        WEB_BROWSER_REPORT({ tm4Port.bulletSpawns = (tm4Port.bulletSpawns || 0) + 1; });
    return result;
}
static void process(void* object)
{
    Bullet* bullet = object;
    if (bullet->motion.fields.world_impact || bullet->hit_pending)
        WEB_BROWSER_REPORT({ tm4Port.bulletImpacts = (tm4Port.bulletImpacts || 0) + 1; });
    BulletProcess(bullet);
}
static void destroy(void* object)
{
    BulletDestructor(object);
}
static void display(void* object, Tm4OrderingTag* ordering, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
    BulletDisplay(object, ordering, output, end, view);
    if (*output != start)
        WEB_BROWSER_REPORT({ tm4Port.bulletDraws = (tm4Port.bulletDraws || 0) + 1; });
}

OSWord WebBulletExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("BulletClassConstructor", construct_class);
    EXPORT("BulletConstructor", construct);
    EXPORT("BulletProcess", process);
    EXPORT("BulletDestructor", destroy);
    EXPORT("BulletDisplay", display);
#undef EXPORT
    return 0;
}
