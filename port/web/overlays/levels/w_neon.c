#include "src/modules/levels/w_neon/private.h"
#include "../../overlays.h"
#include "tm4/main/game.h"
#include "port/web/browser_report.h"
#include <string.h>

void TrainClassConstructor(RegistryDirectory*);
void UfoClassConstructor(RegistryDirectory*);
s32 TrainInstanceConstructor(Train*, RegistryDirectory*);
s32 UfoInstanceConstructor(Ufo*, RegistryDirectory*);
void TrainDestructor(Train*);
void UfoDestructor(Ufo*);
void TrainDisplay(Train*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
void InteractCarWithTrain(Car*, Train*);
void UfoDisplay(Ufo*, Tm4OrderingTag*, u8**, u8*, MATRIX*);

static void bind_imports(void)
{
    OSRegisterCarPhysics();
    OSRegisterSoundEmitter();
    OSRegisterInteract();
}

static void train_class(RegistryDirectory* directory)
{
    bind_imports();
    TrainClassConstructor(directory);
}

static void ufo_class(RegistryDirectory* directory)
{
    bind_imports();
    UfoClassConstructor(directory);
}

static s32 train_instance(Train* train, RegistryDirectory* directory)
{
    s32 result = TrainInstanceConstructor(train, directory);
    if (result)
        WEB_BROWSER_REPORT({ tm4Port.trainInstances = (tm4Port.trainInstances || 0) + 1; });
    return result;
}

static s32 ufo_instance(Ufo* ufo, RegistryDirectory* directory)
{
    s32 result = UfoInstanceConstructor(ufo, directory);
    if (result)
        WEB_BROWSER_REPORT({ tm4Port.ufoInstances = (tm4Port.ufoInstances || 0) + 1; });
    return result;
}

static void train_process(Train* train)
{
    if (GameInfo.game_type == GAME_TYPE_TOURNAMENT && GameInfo.bosses_spawned) {
        TrainProcess(train);
        return;
    }
    TrainProcess(train);
    WEB_BROWSER_REPORT(
        { tm4Port.trainPosition = ([ $0, $1, $2 ]); }, train->path.local_to_world.t[0],
        train->path.local_to_world.t[1], train->path.local_to_world.t[2]);
}

static void ufo_process(Ufo* ufo)
{
    Car* held = ufo->car;
    UfoProcess(ufo);
    WEB_BROWSER_REPORT(
        {
            tm4Port.ufoPosition = ([ $0, $1, $2 ]);
            tm4Port.ufoHolding = !!$3;
        },
        ufo->path.local_to_world.t[0], ufo->path.local_to_world.t[1], ufo->path.local_to_world.t[2],
        ufo->car != NULL);
    if (!held && ufo->car)
        WEB_BROWSER_REPORT(
            {
                tm4Port.ufoCaptures = (tm4Port.ufoCaptures || 0) + 1;
                tm4Port.ufoCapturedPlayer = !!$0;
            },
            ufo->car == GameInfo.players[0].car);
    if (held && !ufo->car) {
        SVECTOR* drop = ufo->drop_world_position;
        WEB_BROWSER_REPORT(
            {
                tm4Port.ufoReleases = (tm4Port.ufoReleases || 0) + 1;
                tm4Port.ufoRelease
                    = ({ position : [ $0, $1, $2 ], drop : [ $3, $4, $5 ], radius : $6 });
            },
            ufo->path.local_to_world.t[0], ufo->path.local_to_world.t[1],
            ufo->path.local_to_world.t[2], drop ? drop->vx : 0, drop ? drop->vy : 0,
            drop ? drop->vz : 0, ufo->drop_radius);
    }
}

static void train_display(Train* train, Tm4OrderingTag* table, u8** cursor, u8* end, MATRIX* view)
{
    u8* start = *cursor;
    TrainDisplay(train, table, cursor, end, view);
    if (*cursor != start)
        WEB_BROWSER_REPORT({ tm4Port.trainDraws = (tm4Port.trainDraws || 0) + 1; });
}

static void ufo_display(Ufo* ufo, Tm4OrderingTag* table, u8** cursor, u8* end, MATRIX* view)
{
    u8* start = *cursor;
    UfoDisplay(ufo, table, cursor, end, view);
    if (*cursor != start)
        WEB_BROWSER_REPORT({ tm4Port.ufoDraws = (tm4Port.ufoDraws || 0) + 1; });
}

static void train_collision(Car* car, Train* train)
{
    s32 health = car->health;
    InteractCarWithTrain(car, train);
    if (car == GameInfo.players[0].car && car->health != health)
        WEB_BROWSER_REPORT({ tm4Port.trainPlayerHits = (tm4Port.trainPlayerHits || 0) + 1; });
}

static void train_destroy(Train* train)
{
    TrainDestructor(train);
    WEB_BROWSER_REPORT({ tm4Port.trainRemoved = (tm4Port.trainRemoved || 0) + 1; });
}

static void ufo_destroy(Ufo* ufo)
{
    UfoDestructor(ufo);
    WEB_BROWSER_REPORT({ tm4Port.ufoRemoved = (tm4Port.ufoRemoved || 0) + 1; });
}

OSWord WebNeonExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("InteractCarWithTrain", train_collision);
    EXPORT("TrainClassConstructor", train_class);
    EXPORT("UfoClassConstructor", ufo_class);
    EXPORT("TrainInstanceConstructor", train_instance);
    EXPORT("UfoInstanceConstructor", ufo_instance);
    EXPORT("TrainProcess", train_process);
    EXPORT("UfoProcess", ufo_process);
    EXPORT("TrainDisplay", train_display);
    EXPORT("UfoDisplay", ufo_display);
    EXPORT("TrainDestructor", train_destroy);
    EXPORT("UfoDestructor", ufo_destroy);
#undef EXPORT
    return 0;
}
