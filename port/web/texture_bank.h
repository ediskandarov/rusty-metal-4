#ifndef RUSTYMETAL_TEXTURE_BANK_H
#define RUSTYMETAL_TEXTURE_BANK_H
#include "tm4_scalar.h"

/* A bank has PS1's 1024×512 RGB5551 word layout, independently of framebuffer VRAM.
 * Textured polygons select it with bits 9, 10, 12 and 13 of their texture-page word; zero is stock VRAM.
 * The bank owns a copy of the pixels until released. IDs are resources, not simulation state. */
int WebTextureBankCreate(const u16* pixels);
void WebTextureBankDestroy(unsigned bank);
/* Restore the returned target after a synchronous upload scope. */
unsigned WebTextureBankSelectUpload(unsigned bank);
#endif
