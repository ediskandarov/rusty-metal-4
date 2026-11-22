#include "car_effects_runtime.h"
#include "car_profile.h"
#include "port/web/interpolation.h"
#include "tm4/main/game.h"
#include "tm4/main/object.h"
#include "tm4/main/os.h"
#include "tm4/main/sound.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/car.h"
#include <stdio.h>
#include <string.h>

static int load(char* name, Rm4CarEffectProfile* effect, int overlay)
{
    memset(effect, 0, sizeof(*effect));
    Rm4CarProfileReader reader = WebCarProfileOpen(name);
    if (!reader.resource)
        return reader.valid;
    effect->resource = reader.resource;
    char* body = WebCarProfileString(&reader, "drawBody", 0);
    char* layer = WebCarProfileString(&reader, "drawOverlay", 0);
    if ((!body && !layer) || (!overlay && (!body || layer)))
        return 0;
    if (body) {
        effect->body = (Rm4CarEffectDraw)OSSymbolGetAddress(body);
        if (!effect->body)
            return 0;
    }
    if (layer) {
        effect->overlay = (Rm4CarEffectDraw)OSSymbolGetAddress(layer);
        if (!effect->overlay)
            return 0;
    }
    effect->minimum_light = WebCarProfileNumber(&reader, "minimumLight", 64, 0, 140);
    effect->sound = WebCarProfileString(&reader, "sound", 0);
    return reader.valid && (!effect->sound || SoundIsLooping(effect->sound));
}
int WebCarEffectsLoad(Car* car)
{
    if (!load("freezeEffect", &car->freeze_effect, 1)
        || !load("invisibilityEffect", &car->invisibility_effect, 0)) {
        fprintf(stderr, "Invalid car appearance profile for %s\n", car->character_name);
        return 0;
    }
    return 1;
}
void WebCarEffectLoop(Car* car, int effect)
{
    const Rm4CarEffectProfile* profile
        = effect == RM4_CAR_FREEZE ? &car->freeze_effect : &car->invisibility_effect;
    SoundEmitter** loop = effect == RM4_CAR_FREEZE ? &car->freeze_sound : &car->invisibility_sound;
    if (profile->sound && !*loop)
        *loop = ObjectCreate("soundEmitter",
            OBJECT_HAS_OWNER | OBJECT_DESTROY_WITH_OWNER | OBJECT_FOLLOW_OWNER, car, profile->sound,
            0);
}
s32 WebCarEffectsMinimumLight(const Car* car)
{
    if (car->freeze_ticks)
        return car->freeze_effect.resource ? car->freeze_effect.minimum_light : 64;
    if (car->invisibility_ticks && car->invisibility_effect.resource)
        return car->invisibility_effect.minimum_light;
    return 64;
}
void WebCarEffectOverlay(const Car* car, const Rm4CarEffectFace* face)
{
    if (car->freeze_ticks && car->freeze_effect.overlay)
        car->freeze_effect.overlay(car->freeze_effect.resource, face);
}
int WebCarEffectBodyHidden(const Car* car)
{
    return car->invisibility_ticks && car->invisibility_effect.resource
        && GameInfo.active_view->object != WebInterpolationCarIdentity(car);
}
int WebCarEffectBody(const Car* car, const Rm4CarEffectFace* face)
{
    if (WebCarEffectBodyHidden(car))
        return 1;
    const Rm4CarEffectProfile* effect = NULL;
    if (car->invisibility_ticks && car->invisibility_effect.resource)
        effect = &car->invisibility_effect;
    else if (car->freeze_ticks && car->freeze_effect.resource)
        effect = &car->freeze_effect;
    if (!effect || !effect->body)
        return 0;
    effect->body(effect->resource, face);
    return 1;
}
