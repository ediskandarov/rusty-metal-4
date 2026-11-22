#ifndef RM4_SURFACE_EFFECTS_STATE_H
#define RM4_SURFACE_EFFECTS_STATE_H

#include "port/web/snapshot_fields.h"
#include "surface_effects_runtime.h"

struct NetStateOutput;
extern const SnapshotGroupFields WebSurfaceEffectsSnapshot;
void WebSurfaceEffectsWriteState(struct NetStateOutput* output, const Rm4SurfaceBinding* binding);

#endif
