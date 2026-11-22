#ifndef RM4_CAR_EFFECTS_H
#define RM4_CAR_EFFECTS_H

#include "port/web/subpixel.h"
#include "tm4/main/render.h"
struct Car;
struct CarRenderFace;
struct RegistryDirectory;

/* Borrowed render-only context. Do not mutate simulation state, allocate game
   objects, advance RNG or retain these pointers. The port decides visibility.
   Packets must fit [*cursor, end); use private draw-mode packets for each layer. */
typedef struct {
    const struct Car* car;
    const struct CarRenderFace* face;
    const Tm4ScreenPoint* screen;
    const PsyzSubpixelPosition* precise;
    Tm4OrderingTag* ordering;
    u8** cursor;
    u8* end;
    int invisible;
} Rm4CarEffectFace;
typedef void (*Rm4CarEffectDraw)(struct RegistryDirectory* profile, const Rm4CarEffectFace* face);

#endif
