#ifndef TM4_PSYZ_SUBPIXEL_H
#define TM4_PSYZ_SUBPIXEL_H

#include <sys/types.h>

enum {
    PSYZ_STABILIZE_VERTICES = 1 << 0,
    PSYZ_PERSPECTIVE_TEXTURES = 1 << 1,
};

typedef struct PsyzSubpixelPosition {
    float x, y, inv_depth;
} PsyzSubpixelPosition;

int Psyz_DrawPushPrimWithPositions(u_long* packets, int max_len,
    const PsyzSubpixelPosition* positions, unsigned int options);

#endif
