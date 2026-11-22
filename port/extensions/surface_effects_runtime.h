#ifndef RM4_SURFACE_EFFECTS_RUNTIME_H
#define RM4_SURFACE_EFFECTS_RUNTIME_H

#include "surface_effects.h"

struct Car;
typedef struct {
    void* instance;
    uint32_t contacts;
    /* Physics scratch: cleared before each step, excluded from snapshots. */
    int32_t compression[RM4_SURFACE_WHEELS], impact_speed;
    uint32_t discontinuous;
} Rm4SurfaceBinding;

void WebSurfaceEffectsLoad(void);
void WebSurfaceEffectsUnload(void);
/* Return true when the provider owns contact/landing audio for this car. */
int WebSurfaceEffectsOwnsAudio(const struct Car* car);
void WebSurfaceEffectsImpact(struct Car* car, int32_t speed);
void WebSurfaceEffectsCompression(struct Car* car, unsigned wheel, int32_t compression);
int WebSurfaceEffectsAttach(struct Car* car);
void WebSurfaceEffectsDetach(struct Car* car);
void WebSurfaceEffectsBegin(struct Car* car);
void WebSurfaceEffectsStep(struct Car* car);
void WebSurfaceEffectsReset(struct Car* car);

#endif
