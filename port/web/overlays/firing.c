#include "src/modules/firing/private.h"
#include "../overlays.h"
#include <emscripten.h>
#include <string.h>

extern u32 FireRingSizeof;
s32 FireRingConstructor(FireRing*, va_list);
void FireRingProcess(FireRing*);
void FireRingDestructor(FireRing*);

static s32 construct(void* object, va_list arguments)
{
    s32 result = FireRingConstructor(object, arguments);
    if (result)
        EM_ASM({ tm4Port.fireRingSpawns = (tm4Port.fireRingSpawns || 0) + 1; });
    return result;
}
static void process(void* object)
{
    FireRing* ring = object;
    EM_ASM(
        {
            tm4Port.fireRingPeakParticles = Math.max(tm4Port.fireRingPeakParticles || 0, $0);
            tm4Port.fireRingPeakRadius = Math.max(tm4Port.fireRingPeakRadius || 0, $1);
        },
        ring->particle_count, ring->radius);
    FireRingProcess(ring);
}
static void destroy(void* object)
{
    FireRingDestructor(object);
    EM_ASM({ tm4Port.fireRingRemoved = (tm4Port.fireRingRemoved || 0) + 1; });
}
OSWord WebFireRingExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("FireRingConstructor", construct);
    EXPORT("FireRingProcess", process);
    EXPORT("FireRingDestructor", destroy);
#undef EXPORT
    return 0;
}
