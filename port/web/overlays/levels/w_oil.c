#include "src/modules/levels/w_oil/private.h"
#include "../../overlays.h"
#include "port/web/browser_report.h"
#include <string.h>

void HelicopterClassConstructor(RegistryDirectory*);
s32 HelicopterInstanceConstructor(Helicopter*, RegistryDirectory*);
void HelicopterDisplay(Helicopter*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
void HelicopterDestructor(Helicopter*);

static void construct_class(RegistryDirectory* directory)
{
    OSRegisterInteract();
    HelicopterWorldInfo = NULL;
    HelicopterBladeTopInfo = NULL;
    HelicopterBladeBackInfo = NULL;
    HelicopterClassConstructor(directory);
}

static s32 construct(Helicopter* helicopter, RegistryDirectory* directory)
{
    s32 result = HelicopterInstanceConstructor(helicopter, directory);
    if (result)
        WEB_BROWSER_REPORT({ tm4Port.helicopterInstances = (tm4Port.helicopterInstances || 0) + 1; });
    return result;
}

static void process(Helicopter* helicopter)
{
    HelicopterProcess(helicopter);
    WEB_BROWSER_REPORT(
        {
            tm4Port.helicopter = ({
                position : [ $0, $1, $2 ],
                topAngle : $3,
                tailAngle : $4,
                health : $5,
                pickupActive : $6,
                wrapped : !!$7
            });
        },
        helicopter->path.local_to_world.t[0], helicopter->path.local_to_world.t[1],
        helicopter->path.local_to_world.t[2], helicopter->top_blade_angle,
        helicopter->tail_blade_angle, helicopter->health,
        helicopter->health_powerup ? helicopter->health_powerup->position.fields.active : -1,
        helicopter->path.wrapped);
    if (helicopter->path.wrapped)
        WEB_BROWSER_REPORT({ tm4Port.helicopterLaps = (tm4Port.helicopterLaps || 0) + 1; });
}

static void display(
    Helicopter* helicopter, Tm4OrderingTag* table, u8** cursor, u8* end, MATRIX* view)
{
    u8* start = *cursor;
    HelicopterDisplay(helicopter, table, cursor, end, view);
    if (*cursor != start)
        WEB_BROWSER_REPORT({ tm4Port.helicopterDraws = (tm4Port.helicopterDraws || 0) + 1; });
}

static void destroy(Helicopter* helicopter)
{
    HelicopterDestructor(helicopter);
    WEB_BROWSER_REPORT({ tm4Port.helicopterRemoved = (tm4Port.helicopterRemoved || 0) + 1; });
}

OSWord WebOilExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("HelicopterClassConstructor", construct_class);
    EXPORT("HelicopterInstanceConstructor", construct);
    EXPORT("HelicopterProcess", process);
    EXPORT("HelicopterDisplay", display);
    EXPORT("HelicopterDestructor", destroy);
#undef EXPORT
    return 0;
}
