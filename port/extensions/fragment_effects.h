#ifndef RM4_FRAGMENT_EFFECTS_H
#define RM4_FRAGMENT_EFFECTS_H

#include <libgte.h>
#include <stdint.h>

enum { RM4_FRAGMENT_EFFECTS_VERSION = 1 };

typedef struct {
    SVECTOR position; /* World units; pad is zero. */
    int32_t effect_size; /* World units: twice the fragment radius. */
    int32_t material; /* Map material index. */
    int32_t surface_kind; /* Kind of that material, not its index. */
} Rm4FragmentImpact;

/* Immutable descriptor exported by world/fragmentEffects. Replaces both visuals
 * and audio for every stock fragment impact on this map. Called synchronously,
 * including replay, but not on snapshot restore. Only create presentation objects
 * with snapshot schemas and use the engine sound lifecycle. Use randrand for
 * cosmetic randomness. Do not retain the event or alter the fragment's physics. */
typedef struct {
    uint32_t version, size;
    void (*impact)(const Rm4FragmentImpact* event);
} Rm4FragmentEffects;

#endif
