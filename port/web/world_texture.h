#ifndef RUSTYMETAL_WORLD_TEXTURE_H
#define RUSTYMETAL_WORLD_TEXTURE_H
#include "tm4_scalar.h"
void WebWorldTextureInitialize(void);
u8* WebWorldTextureShaders(u8* original);
void* WebWorldTextureHorizon(void* original);
void WebWorldTextureBindReflections(void);
void WebWorldTextureClose(void);
void WebWorldAnimateTextures(void);
#endif
