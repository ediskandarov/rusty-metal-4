#include "src/modules/cars/auger/private.h"
#include "../../overlays.h"
#include "tm4/main/game.h"
#include <emscripten.h>
#include <string.h>

static void construct_class(RegistryDirectory* directory)
{
    OSRegisterSoundEmitter();
    OSRegisterCarPhysics();
    OSRegisterCarDisplay();
    CarAugerClassConstructor(directory);
}

static s32 process(Car* car, void* context)
{
    AugerDrill* drill = context;
    s32 result = CarAugerProcess(car, drill);
    if (car == GameInfo.players[0].car) {
        Car* target = GameIsCarRegistered(drill->target) ? drill->target : NULL;
        EM_ASM(
            {
                tm4Port.auger = ({
                    angle : $0,
                    speed : $1,
                    ticks : $2,
                    holding : !!$3,
                    targetHealth : $4,
                    targetUp : [ $5, $6, $7 ],
                    sound : !!$8
                });
            },
            drill->angle, drill->angular_speed, drill->active_ticks, target != NULL,
            target ? target->health : -1, target ? target->transform.m[0][1] : 0,
            target ? target->transform.m[1][1] : 0, target ? target->transform.m[2][1] : 0,
            drill->loop_sound != NULL);
    }
    return result;
}

OSWord WebAugerExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("CarAugerClassConstructor", construct_class);
    EXPORT("CarAugerProcess", process);
#undef EXPORT
    return 0;
}
