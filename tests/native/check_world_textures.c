/* Real world texture adapter with an in-memory registry and renderer boundary. */
#include "tm4/main/registry.h"
#include "tm4/main/render.h"
#include "tm4/main/world.h"
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static jmp_buf failure;
static int expect_error;
static void reject_resource(void) __attribute__((noreturn));
static void reject_resource(void)
{
    assert(expect_error);
    longjmp(failure, 1);
}
#define abort reject_resource
#include "port/web/world_texture.c"
#undef abort

struct RegistryFile {
    const char* path;
    int type;
    unsigned size;
    void* data;
};
static u16 pixels[1024 * 512], uploaded[1024 * 512];
static u16 overlay_pixels[] = { 640, 0, 2, 1, 0x1234, 0x5678 };
static char overlay_path[] = "/pack/reflections.bit";
static s32 shader_count = 2;
static u16 shaders[12];
static union {
    u32 alignment;
    u8 bytes[8 + 176 + 128 + 196];
} horizon;
static u16 reflection[4] = { 0, 0, 0, 0x1f0a };
static RegistryFile files[] = {
    { "/world/textureBank", 3, sizeof(pixels), pixels },
    { "/world/textureBankOverlay", 2, sizeof(overlay_path), overlay_path },
    { "/pack/reflections.bit", 3, sizeof(overlay_pixels), overlay_pixels },
    { "/world/displayPolys/numPsxShaders", 4, sizeof(shader_count), &shader_count },
    { "/world/displayPolys/shaderData", 3, sizeof(shaders), shaders },
    { "/world/horiz.bin", 3, sizeof(horizon), &horizon },
    { "/world/textures/reflchro", 3, sizeof(reflection), reflection },
    { "/world/textures/reflspec", 3, sizeof(reflection), reflection },
};
static int stock;
static unsigned active_bank, next_bank = 1, target, creations, destructions;
static void* bound_horizon;
u8* WorldDisplayShaders;
Tm4CardTexture WorldReflectionTextureChrome, WorldReflectionTextureSpecular;
RegistryFile* RegGetFilePtrS(char* path)
{
    if (stock && (!strcmp(path, files[0].path) || !strcmp(path, files[1].path)))
        return NULL;
    for (unsigned i = 0; i < sizeof(files) / sizeof(files[0]); ++i)
        if (!strcmp(path, files[i].path))
            return &files[i];
    return NULL;
}
s32 RegGetFileTypeP(const RegistryFile* file)
{
    return file->type;
}
u32 RegGetFileByteSizeP(const RegistryFile* file)
{
    return file->size;
}
void* RegGetFileDataP(RegistryFile* file)
{
    return file->data;
}
int WebTextureBankCreate(const u16* data)
{
    assert(!active_bank);
    memcpy(uploaded, data, sizeof(uploaded));
    ++creations;
    return active_bank = next_bank;
}
void WebTextureBankDestroy(unsigned bank)
{
    assert(bank == active_bank);
    active_bank = 0;
    ++destructions;
}
unsigned WebTextureBankSelectUpload(unsigned bank)
{
    unsigned previous = target;
    target = bank;
    return previous;
}
void WorldAnimateTextures(void)
{
    assert(target == active_bank);
}
void RenderSetHorizon(Tm4HorizonResource* data)
{
    bound_horizon = data;
}

static void load(void)
{
    WebWorldTextureInitialize();
    WorldDisplayShaders = WebWorldTextureShaders((u8*)shaders);
    RenderSetHorizon(WebWorldTextureHorizon(horizon.bytes));
    memcpy(&WorldReflectionTextureChrome, reflection, 8);
    memcpy(&WorldReflectionTextureSpecular, reflection, 8);
    WebWorldTextureBindReflections();
}
static void invalid(void)
{
    unsigned before = creations, old = active_bank;
    expect_error = 1;
    if (!setjmp(failure)) {
        WebWorldTextureInitialize();
        assert(!"malformed texture resource was accepted");
    }
    expect_error = 0;
    assert(creations == before && active_bank == old);
}
int main(void)
{
    memset(pixels, 0x55, sizeof(pixels));
    shaders[3] = shaders[9] = 0x1f0a;
    horizon.bytes[0] = horizon.bytes[1] = horizon.bytes[2] = 1;
    unsigned page_offset = 8 + 176 + 128 + 32 + 22;
    for (unsigned i = 0; i < 4; ++i)
        *(u16*)(horizon.bytes + page_offset + i * 40) = 0x1f0a;
    for (unsigned pass = 0; pass < 3; ++pass) {
        next_bank = pass == 1 ? 15 : 1;
        load();
        assert(uploaded[640] == 0x1234 && uploaded[641] == 0x5678);
        assert(pixels[640] == 0x5555 && shaders[3] == 0x1f0a && reflection[3] == 0x1f0a);
        assert(WorldDisplayShaders != (u8*)shaders && bound_horizon != horizon.bytes);
        u16 page = 0x10a | (next_bank << 9);
        assert(WebWorldTexturePage(0x1f6a) == (page | 0x60));
        assert(((u16*)WorldDisplayShaders)[3] == page);
        assert(((u16*)WorldDisplayShaders)[9] == page);
        for (unsigned i = 0; i < 4; ++i) {
            assert(*(u16*)((u8*)bound_horizon + page_offset + i * 40) == page);
            assert(*(u16*)(horizon.bytes + page_offset + i * 40) == 0x1f0a);
        }
        assert(WorldReflectionTextureChrome.uv.tpage == page);
        WebWorldTextureBindReflections();
        target = 9;
        WebWorldAnimateTextures();
        assert(target == 9);
        if (pass == 1) {
            WebWorldTextureClose();
            assert(!WorldDisplayShaders && !bound_horizon && !active_bank);
            assert(WorldReflectionTextureChrome.uv.tpage == 0x1f0a);
            stock = 1;
            load();
            assert(WorldDisplayShaders == (u8*)shaders && bound_horizon == horizon.bytes);
            assert(!active_bank && WorldReflectionTextureChrome.uv.tpage == 0x1f0a);
            assert(WebWorldTexturePage(0x16a) == 0x16a);
            WebWorldAnimateTextures();
            assert(target == 9);
            stock = 0;
        }
    }
    for (unsigned i = 0; i < sizeof(files) / sizeof(files[0]); ++i) {
        unsigned size = files[i].size;
        files[i].size = size - 1;
        invalid();
        files[i].size = size;
        int type = files[i].type;
        files[i].type = -1;
        invalid();
        files[i].type = type;
    }
    shader_count = -1;
    invalid();
    shader_count = 65536;
    invalid();
    shader_count = 2;
    overlay_pixels[0] = 1024;
    invalid();
    overlay_pixels[0] = 640;
    WebWorldTextureClose();
    WebWorldTextureClose();
    assert(creations == destructions && !active_bank);
    puts("PASS texture lifecycle, immutable resources, upload scope and malformed bundles");
    return 0;
}
