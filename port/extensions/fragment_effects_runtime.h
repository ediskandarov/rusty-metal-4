#ifndef RM4_FRAGMENT_EFFECTS_RUNTIME_H
#define RM4_FRAGMENT_EFFECTS_RUNTIME_H

#include "fragment_effects.h"

void WebFragmentEffectsLoad(void);
void WebFragmentEffectsUnload(void);
/* Zero means use the original TM4 effect. A provider may intentionally emit nothing. */
int WebFragmentEffectsImpact(
    const SVECTOR* position, int32_t size, int32_t material, int32_t surface_kind);

#endif
