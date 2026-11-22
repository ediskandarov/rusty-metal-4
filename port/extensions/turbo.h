#ifndef RM4_TURBO_H
#define RM4_TURBO_H

#include <libgte.h>
struct RegistryDirectory;

/* Borrowed only during construction. The owner is the car; process runs after
   its physics. Read owner->turbo_thrust_applied for this tick's actual boost.
   Copy profile settings into snapshot-covered state, never retain this context. */
typedef struct {
    struct RegistryDirectory* profile;
    SVECTOR position;
} Rm4TurboAppearanceContext;

#endif
