#include "src/modules/ray/private.h"
#include "../overlays.h"
#include <emscripten.h>
#include <string.h>

void WeaponRayBeamClassConstructor(RegistryDirectory*);
void WeaponRayBeamClassDestructor(RegistryDirectory*);
s32 WeaponRayBeamConstructor(RayBeam*, va_list);
s32 WeaponRayBeamInstanceConstructor(RayBeam*, RegistryDirectory*);
void WeaponRayBeamProcess(RayBeam*);
void WeaponRayBeamDestructor(RayBeam*);
void WeaponRayBeamDisplay(RayBeam*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
extern u32 WeaponRayBeamSizeof;

static void construct_class(RegistryDirectory* directory)
{
    OSRegisterSoundEmitter();
    OSRegisterAnimInfo();
    OSRegisterExplosion();
    OSRegisterBuildMatrixFunc();
    OSRegisterCarPhysics();
    Import_InteractCarWithAnim_fire = OSSymbolGetAddressAssert("InteractCarWithAnim_fire");
    Import_InteractWithFlammableTerrainPoly
        = OSSymbolGetAddressAssert("InteractWithFlammableTerrainPoly");
    WeaponRayBeamClassConstructor(directory);
}

static s32 construct(void* object, va_list arguments)
{
    s32 result = WeaponRayBeamConstructor(object, arguments);
    if (result) {
        RayBeam* beam = object;
        EM_ASM(
            {
                tm4Port.raySpawns = (tm4Port.raySpawns || 0) + 1;
                tm4Port.lastRay = UTF8ToString($0);
            },
            beam->type->name);
    }
    return result;
}

static void process(void* object)
{
    s32 health = 0;
    for (s32 i = 0; i < GameInfo.car_count; ++i)
        health += GameInfo.cars[i]->health;
    WeaponRayBeamProcess(object);
    for (s32 i = 0; i < GameInfo.car_count; ++i)
        health -= GameInfo.cars[i]->health;
    if (health > 0)
        EM_ASM({ tm4Port.rayDamage = (tm4Port.rayDamage || 0) + $0; }, health);
}

static void destroy(void* object)
{
    WeaponRayBeamDestructor(object);
    EM_ASM({ tm4Port.rayRemoved = (tm4Port.rayRemoved || 0) + 1; });
}

static void display(void* object, Tm4OrderingTag* ordering, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
    WeaponRayBeamDisplay(object, ordering, output, end, view);
    if (*output != start)
        EM_ASM({ tm4Port.rayDraws = (tm4Port.rayDraws || 0) + 1; });
}

OSWord WebRayExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("WeaponRayBeamClassConstructor", construct_class);
    EXPORT("WeaponRayBeamConstructor", construct);
    EXPORT("WeaponRayBeamProcess", process);
    EXPORT("WeaponRayBeamDestructor", destroy);
    EXPORT("WeaponRayBeamDisplay", display);
#undef EXPORT
    return 0;
}
