#include "src/modules/carprt/private.h"
#include "../overlays.h"
#include "tm4/gpu.h"
#include "tm4/main/memory.h"
#include <emscripten.h>
#include <string.h>
s32 CarpartConstructor(Carpart*, va_list);
void CarpartProcess(Carpart*);
void CarpartDisplay(Carpart*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
/* Tank, Minion and Crusher free their private tread faces when the car dies.
 * Debris retains the damaged frame's appearance until its own destruction. */
typedef struct WebCarpart {
    Carpart part;
    CarRenderGroup group;
    CarRenderFace* faces;
} WebCarpart;
static u32 native_size = sizeof(WebCarpart);
static s32 construct(void* object, va_list args)
{
    OSRegisterCarPhysics();
    OSRegisterExplosion();
    WebCarpart* debris = object;
    debris->faces = NULL;
    if (!CarpartConstructor(&debris->part, args))
        return 0;
    debris->group = *debris->part.group;
    CarRenderFrame* frame = &debris->group.frames[CAR_RENDER_FRAME_DAMAGED];
    if (frame->face_count > 0) {
        size_t bytes = frame->face_count * sizeof(*debris->faces);
        debris->faces = MemAlloc(bytes);
        if (!debris->faces)
            return 0;
        memcpy(debris->faces, debris->part.faces + frame->first_face, bytes);
    }
    frame->first_face = 0;
    debris->part.group = &debris->group;
    debris->part.faces = debris->faces;
    EM_ASM({ tm4Port.debrisSpawns = (tm4Port.debrisSpawns || 0) + 1; });
    return 1;
}
static void process(void* object)
{
    CarpartProcess(object);
}
static void destroy(void* object)
{
    WebCarpart* debris = object;
    MemFree(debris->faces);
    EM_ASM({ tm4Port.debrisRemoved = (tm4Port.debrisRemoved || 0) + 1; });
}
static void display(void* object, Tm4OrderingTag* ot, u8** output, u8* end, MATRIX* view)
{
    u8* start = *output;
#if __has_feature(address_sanitizer)
    Carpart* part = object;
    CarRenderFrame* frame = &part->group->frames[CAR_RENDER_FRAME_DAMAGED];
    EM_ASM(
        {
            tm4Port.lastDebris
                = ({ faces : $0, firstFace : $1, faceCount : $2, vertices : $3, group : $4 });
        },
        part->faces, frame->first_face, frame->face_count, part->local_vertices, part->group);
#endif
    CarpartDisplay(object, ot, output, end, view);
    if (*output != start)
        EM_ASM({ tm4Port.debrisDraws = (tm4Port.debrisDraws || 0) + 1; });
}
OSWord WebCarpartExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("CarpartSizeof", &native_size);
    EXPORT("CarpartConstructor", construct);
    EXPORT("CarpartProcess", process);
    EXPORT("CarpartDestructor", destroy);
    EXPORT("CarpartDisplay", display);
#undef EXPORT
    return 0;
}
