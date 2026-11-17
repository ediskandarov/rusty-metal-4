#include "world_texture.h"
#include "texture_bank.h"

#include "tm4/main/registry.h"
#include "tm4/main/render.h"
#include "tm4/main/world.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { BankBytes = 1024 * 512 * 2, BankMask = 0x3e00, ShaderBytes = 12 };
static unsigned world_texture_bank;
static u8 *world_shaders, *world_horizon;
static Tm4CardTexture original_chrome, original_specular;
static int reflections_bound;

static void resource_error(const char* path, const char* reason)
{
    fprintf(stderr, "World textures: %s: %s\n", path, reason);
    abort();
}

static RegistryFile* resource(const char* path, int type, int required)
{
    RegistryFile* file = RegGetFilePtrS((char*)path);
    if (!file) {
        if (required)
            resource_error(path, "missing resource");
        return NULL;
    }
    if (RegGetFileTypeP(file) != type)
        resource_error(path, "wrong resource type");
    return file;
}

static void require_size(RegistryFile* file, const char* path, unsigned bytes)
{
    if (RegGetFileByteSizeP(file) != bytes)
        resource_error(path, "wrong byte length");
}

static void* copy_resource(RegistryFile* file)
{
    unsigned bytes = RegGetFileByteSizeP(file);
    void* copy = malloc(bytes ? bytes : 1);
    if (!copy)
        resource_error("allocation", "out of memory");
    if (bytes)
        memcpy(copy, RegGetFileDataP(file), bytes);
    return copy;
}

u16 WebWorldTexturePage(u16 page)
{
    /* External banks are 512 pixels high: clear the base VRAM upper-page bit too. */
    return (page & ~BankMask) | ((world_texture_bank & 3) << 9) | ((world_texture_bank & 12) << 10);
}

static void bind_world_page(u16* page)
{
    *page = WebWorldTexturePage(*page);
}

void WebWorldTextureClose(void)
{
    if (reflections_bound) {
        WorldReflectionTextureChrome = original_chrome;
        WorldReflectionTextureSpecular = original_specular;
        reflections_bound = 0;
    }
    if (world_horizon)
        RenderSetHorizon(NULL);
    if (WorldDisplayShaders == world_shaders)
        WorldDisplayShaders = NULL;
    free(world_horizon);
    free(world_shaders);
    world_horizon = world_shaders = NULL;
    if (world_texture_bank)
        WebTextureBankDestroy(world_texture_bank);
    world_texture_bank = 0;
}

/* Called before WorldInitialize reads or relocates any map resources. Validate
 * the entire texture bundle first; only runtime copies receive bank bindings. */
void WebWorldTextureInitialize(void)
{
    const char* bank_path = "/world/textureBank";
    const char* overlay_path = "/world/textureBankOverlay";
    RegistryFile* bank = resource(bank_path, REG_FILE_TYPE_BINARY, 0);
    RegistryFile* overlay = resource(overlay_path, REG_FILE_TYPE_STRING, 0);
    if (!bank) {
        if (overlay)
            resource_error(overlay_path, "requires textureBank");
        WebWorldTextureClose();
        return;
    }
    require_size(bank, bank_path, BankBytes);
    const u16* bitmap = NULL;
    if (overlay) {
        const char* path = RegGetFileDataP(overlay);
        unsigned length = RegGetFileByteSizeP(overlay);
        if (!length || !path || path[0] != '/' || !memchr(path, 0, length))
            resource_error(overlay_path, "expected a terminated absolute registry path");
        RegistryFile* image = resource(path, REG_FILE_TYPE_BINARY, 1);
        if (RegGetFileByteSizeP(image) < 8)
            resource_error(path, "truncated bitmap header");
        bitmap = RegGetFileDataP(image);
        unsigned x = bitmap[0], y = bitmap[1], w = bitmap[2], h = bitmap[3];
        if (!w || !h || x + w > 1024 || y + h > 512)
            resource_error(path, "bitmap exceeds texture bank");
        require_size(image, path, 8 + w * h * 2);
    }
    const char* count_path = "/world/displayPolys/numPsxShaders";
    RegistryFile* count_file = resource(count_path, REG_FILE_TYPE_LONG, 1);
    require_size(count_file, count_path, sizeof(s32));
    s32 count = *(const s32*)RegGetFileDataP(count_file);
    if (count < 0 || count > 65535)
        resource_error(count_path, "invalid shader count");
    const char* shaders_path = "/world/displayPolys/shaderData";
    RegistryFile* shaders = resource(shaders_path, REG_FILE_TYPE_BINARY, 1);
    require_size(shaders, shaders_path, count * ShaderBytes);
    const char* horizon_path = "/world/horiz.bin";
    RegistryFile* horizon = resource(horizon_path, REG_FILE_TYPE_BINARY, 0);
    if (horizon) {
        if (RegGetFileByteSizeP(horizon) < 8)
            resource_error(horizon_path, "truncated horizon header");
        const u8* data = RegGetFileDataP(horizon);
        require_size(horizon, horizon_path, 8 + data[0] * 176 + data[1] * 128 + data[2] * 196);
    }
    const char* reflections[] = { "/world/textures/reflchro", "/world/textures/reflspec" };
    for (unsigned i = 0; i < 2; ++i) {
        RegistryFile* texture = resource(reflections[i], REG_FILE_TYPE_BINARY, 0);
        if (texture)
            require_size(texture, reflections[i], 8);
    }

    u16* pixels = copy_resource(bank);
    if (bitmap)
        for (unsigned row = 0; row < bitmap[3]; ++row)
            memcpy(pixels + (bitmap[1] + row) * 1024 + bitmap[0], bitmap + 4 + row * bitmap[2],
                bitmap[2] * sizeof(*pixels));
    u8* shader_copy = copy_resource(shaders);
    u8* horizon_copy = horizon ? copy_resource(horizon) : NULL;
    WebWorldTextureClose();
    world_texture_bank = WebTextureBankCreate(pixels);
    free(pixels);
    if (!world_texture_bank)
        resource_error(bank_path, "texture bank pool exhausted");
    world_shaders = shader_copy;
    world_horizon = horizon_copy;
    for (s32 i = 0; i < count; ++i)
        bind_world_page((u16*)(world_shaders + i * ShaderBytes + 6));
    if (world_horizon) {
        u8* record = world_horizon + 8 + world_horizon[0] * 176 + world_horizon[1] * 128;
        for (unsigned i = 0; i < world_horizon[2]; ++i, record += 196)
            for (unsigned slot = 0; slot < 4; ++slot)
                bind_world_page((u16*)(record + 32 + slot * 40 + 22));
    }
}

u8* WebWorldTextureShaders(u8* original)
{
    return world_texture_bank ? world_shaders : original;
}

void* WebWorldTextureHorizon(void* original)
{
    return world_texture_bank ? world_horizon : original;
}

/* WorldInitialize has now resolved the original reflection materials. */
void WebWorldTextureBindReflections(void)
{
    if (!world_texture_bank || reflections_bound)
        return;
    original_chrome = WorldReflectionTextureChrome;
    original_specular = WorldReflectionTextureSpecular;
    reflections_bound = 1;
    if (RegGetFilePtrS("/world/textures/reflchro"))
        bind_world_page(&WorldReflectionTextureChrome.uv.tpage);
    if (RegGetFilePtrS("/world/textures/reflspec"))
        bind_world_page(&WorldReflectionTextureSpecular.uv.tpage);
}

void WebWorldAnimateTextures(void)
{
    unsigned previous = WebTextureBankSelectUpload(world_texture_bank);
    WorldAnimateTextures();
    WebTextureBankSelectUpload(previous);
}
