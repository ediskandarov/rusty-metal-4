#include "port/web/module_import.h"
#include "tm4/fixed.h"
#include "tm4/modules/car.h"
#include "tm4/modules/sound.h"

void CarUpdateEngineSound(Car* car)
{
    if (car->engine_sound) {
        s32 pitch = car->force_sum * 2;
        if (pitch > ONE)
            pitch = ONE;
        WEB_MODULE("sound", SoundEmitterSetPitchScale)(car->engine_sound, pitch);
    }
}
