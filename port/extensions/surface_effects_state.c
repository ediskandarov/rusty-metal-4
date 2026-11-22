#include "surface_effects_state.h"
#include "port/web/net_state_fields.h"

/* The object graph restores the instance. Contacts survive replay boundaries;
   observations collected inside a physics step do not. */
static const SnapshotField surface_fields[] = {
    SNAP_WEAK_REF(Rm4SurfaceBinding, instance, NULL),
    SNAP_POD(Rm4SurfaceBinding, contacts),
    SNAP_TRANSIENT(Rm4SurfaceBinding, compression),
    SNAP_TRANSIENT(Rm4SurfaceBinding, impact_speed),
    SNAP_TRANSIENT(Rm4SurfaceBinding, discontinuous),
    { 0 },
};
const SnapshotGroupFields WebSurfaceEffectsSnapshot = { surface_fields, NULL };

void WebSurfaceEffectsWriteState(NetStateOutput* hash, const Rm4SurfaceBinding* binding)
{
    VALUE(handle(binding->instance));
    VALUE(binding->contacts);
}
