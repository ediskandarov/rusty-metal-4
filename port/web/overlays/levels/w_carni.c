#include "src/modules/levels/w_carni/private.h"
#include "../../overlays.h"
#include "tm4/main/game.h"
#include <emscripten.h>
#include <string.h>

void CoasterClassConstructor(RegistryDirectory*);
s32 CoasterInstanceConstructor(Coaster*, RegistryDirectory*);
void CoasterDestructor(Coaster*);
void CoasterDisplay(Coaster*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
void InteractCarWithCoaster(Car*, Coaster*);

static void bind_imports(void)
{
    OSRegisterCarPhysics();
    OSRegisterSoundEmitter();
    OSRegisterInteract();
}

static void coaster_class(RegistryDirectory* directory)
{
    bind_imports();
    CoasterClassConstructor(directory);
}

static s32 coaster_instance(Coaster* coaster, RegistryDirectory* directory)
{
    s32 result = CoasterInstanceConstructor(coaster, directory);
    if (result)
        EM_ASM({ tm4Port.coasterInstances = (tm4Port.coasterInstances || 0) + 1; });
    return result;
}

static void coaster_process(Coaster* coaster)
{
    if (GameInfo.game_type == GAME_TYPE_TOURNAMENT && GameInfo.bosses_spawned) {
        CoasterProcess(coaster);
        return;
    }
    CoasterProcess(coaster);
    EM_ASM(
        { tm4Port.coasterPosition = ([ $0, $1, $2 ]); }, coaster->path.local_to_world.t[0],
        coaster->path.local_to_world.t[1], coaster->path.local_to_world.t[2]);
}

static void coaster_display(
    Coaster* coaster, Tm4OrderingTag* table, u8** cursor, u8* end, MATRIX* view)
{
    u8* start = *cursor;
    CoasterDisplay(coaster, table, cursor, end, view);
    if (*cursor != start)
        EM_ASM({ tm4Port.coasterDraws = (tm4Port.coasterDraws || 0) + 1; });
}

static void coaster_collision(Car* car, Coaster* coaster)
{
    s32 health = car->health;
    InteractCarWithCoaster(car, coaster);
    if (car == GameInfo.players[0].car && car->health != health)
        EM_ASM({ tm4Port.coasterPlayerHits = (tm4Port.coasterPlayerHits || 0) + 1; });
}

static void coaster_destroy(Coaster* coaster)
{
    CoasterDestructor(coaster);
    EM_ASM({ tm4Port.coasterRemoved = (tm4Port.coasterRemoved || 0) + 1; });
}

OSWord WebCarnivalExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("InteractCarWithCoaster", coaster_collision);
    EXPORT("CoasterClassConstructor", coaster_class);
    EXPORT("CoasterInstanceConstructor", coaster_instance);
    EXPORT("CoasterProcess", coaster_process);
    EXPORT("CoasterDisplay", coaster_display);
    EXPORT("CoasterDestructor", coaster_destroy);
#undef EXPORT
    return 0;
}
