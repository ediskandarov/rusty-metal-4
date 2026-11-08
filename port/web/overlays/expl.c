#include "src/modules/expl/private.h"
#include "../overlays.h"
#include "tm4/gpu.h"
#include <emscripten.h>
#include <string.h>
void ExplosionShockWaveClassConstructor(RegistryDirectory*);
void ExplosionShockWaveClassDestructor(RegistryDirectory* directory);
s32 ExplosionShockWaveConstructor(ExplosionWave*, va_list);
void ExplosionShockWaveProcess(ExplosionWave*);
void ExplosionShockWaveDestructor(ExplosionWave*);
void ExplosionShockWaveDisplay(ExplosionWave*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
static s32 construct(void* object, va_list args)
{
    s32 result = ExplosionShockWaveConstructor(object, args);
    if (result) {
        ExplosionWave* wave = object;
        EM_ASM(
            {
                tm4Port.shockwaveSpawns = (tm4Port.shockwaveSpawns || 0) + 1;
                tm4Port.lastShockwave = UTF8ToString($0);
            },
            wave->definition->name);
    }
    return result;
}
static void destroy(void* object)
{
    ExplosionShockWaveDestructor(object);
    EM_ASM({ tm4Port.shockwaveRemoved = (tm4Port.shockwaveRemoved || 0) + 1; });
}
static void display(void* object, Tm4OrderingTag* ordering, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
    ExplosionShockWaveDisplay(object, ordering, output, end, view);
    if (start != *output)
        EM_ASM({ tm4Port.shockwaveDraws = (tm4Port.shockwaveDraws || 0) + 1; });
}
static void destroy_class(RegistryDirectory* directory)
{
    ExplosionShockWaveClassDestructor(directory);
}
OSWord WebExplExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("ExplosionShockWaveClassDestructor", destroy_class);
    EXPORT("ExplosionShockWaveConstructor", construct);
    EXPORT("ExplosionShockWaveDestructor", destroy);
    EXPORT("ExplosionShockWaveDisplay", display);
#undef EXPORT
    return 0;
}
