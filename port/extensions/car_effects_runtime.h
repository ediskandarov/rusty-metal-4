#ifndef RM4_CAR_EFFECTS_RUNTIME_H
#define RM4_CAR_EFFECTS_RUNTIME_H
#include "car_effects.h"
#include "tm4/main/registry.h"

typedef struct {
    RegistryDirectory* resource;
    Rm4CarEffectDraw body, overlay;
    char* sound;
    s32 minimum_light;
} Rm4CarEffectProfile;
enum { RM4_CAR_FREEZE, RM4_CAR_INVISIBILITY };

int WebCarEffectsLoad(struct Car* car);
void WebCarEffectLoop(struct Car* car, int effect);
s32 WebCarEffectsMinimumLight(const struct Car* car);
void WebCarEffectOverlay(const struct Car* car, const Rm4CarEffectFace* face);
int WebCarEffectBodyHidden(const struct Car* car);
/* True means the body was handled or intentionally hidden. */
int WebCarEffectBody(const struct Car* car, const Rm4CarEffectFace* face);
#endif
