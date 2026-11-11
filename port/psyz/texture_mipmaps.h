#ifndef TM4_PSYZ_TEXTURE_MIPMAPS_H
#define TM4_PSYZ_TEXTURE_MIPMAPS_H

#include <stdbool.h>
#include <stdint.h>

/* UV bounds belong to a complete primitive, including both triangles of a quad. */
typedef struct PsyzTextureView {
    uint16_t page, clut;
    uint32_t window;
    int x, y, width, height;
} PsyzTextureView;

/* Uses reserved texture unit 2 and leaves unit 0 active. Each returned array has
 * two RGBA layers with separate coverage for each PS1 mask bit. */
unsigned PsyzMipmaps_Get(unsigned vram, bool gles, const PsyzTextureView* view, bool anisotropic);
void PsyzMipmaps_Invalidate(int x, int y, int width, int height);
void PsyzMipmaps_Shutdown(void);

#endif
