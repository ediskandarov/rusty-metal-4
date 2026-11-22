#include "port/extensions/map_settings.h"
#include <assert.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static jmp_buf rejected;
static void reject(void)
{
    longjmp(rejected, 1);
}
#define abort reject
#include "port/extensions/map_settings.c"
#undef abort

struct RegistryFile {
    const char* name;
    s32 type;
    u32 bytes;
    u8 data[4];
};
static struct RegistryFile files[8];
static int count, has_render;
static char world_directory, render_directory;
#define WORLD ((RegistryDirectory*)&world_directory)
#define RENDER ((RegistryDirectory*)&render_directory)
static Tm4WorldSettings defaults = {
    .background_color = { 64, 64, 64, 96 },
    .unknown04 = { 1, 2, 3, 4, 5, 6, 7, 8 },
    .minimum_single_player_faces = 800,
    .maximum_single_player_faces = 1000,
    .minimum_split_screen_faces = 500,
    .maximum_split_screen_faces = 700,
};
static RegistryFile* add(const char* name, s32 value)
{
    RegistryFile* file = &files[count++];
    *file = (RegistryFile) { .name = name, .type = REG_FILE_TYPE_LONG, .bytes = 4 };
    memcpy(file->data, &value, 4);
    return file;
}
RegistryDirectory* RegGetDirectoryPtrPS(RegistryDirectory* dir, char* name)
{
    return dir == WORLD && has_render && !strcmp(name, "renderSettings") ? RENDER : NULL;
}
RegistryFile* RegGetFilePtrPS(RegistryDirectory* dir, char* name)
{
    for (int i = 0; i < count; ++i)
        if (!strcmp(files[i].name, name))
            return &files[i];
    return NULL;
}
s32 RegGetFileTypeP(const RegistryFile* file)
{
    return file->type;
}
u32 RegGetFileByteSizeP(const RegistryFile* file)
{
    return file->bytes;
}
void* RegGetFileDataP(RegistryFile* file)
{
    return file->data;
}
static void bad(void)
{
    if (!setjmp(rejected)) {
        WebMapSettingsLoad(WORLD, &defaults);
        assert(!"Invalid settings accepted");
    }
}
int main(void)
{
    Tm4WorldSettings original = defaults;
    assert(WebMapSettingsLoad(WORLD, &defaults) == &defaults);
    has_render = 1;
    RegistryFile* color = add("backgroundColor", 0);
    color->type = REG_FILE_TYPE_BINARY;
    memcpy(color->data, (u8[]) { 35, 50, 70, 0 }, 4);
    Tm4WorldSettings* settings = WebMapSettingsLoad(WORLD, &defaults);
    assert(settings != &defaults && settings->minimum_single_player_faces == 800);
    assert(settings->maximum_single_player_faces == 1000);
    assert(settings->minimum_split_screen_faces == 500);
    assert(settings->maximum_split_screen_faces == 700);
    assert(settings->background_color.r == 35 && settings->background_color.cd == 96);
    assert(!memcmp(settings->unknown04, defaults.unknown04, 8));
    assert(!memcmp(&original, &defaults, sizeof(defaults)));
    color->data[3] = 1;
    bad();
    color->data[3] = 0;
    color->bytes = 3;
    bad();
    color->bytes = 4;
    add("renderSettings", 1);
    bad();
    --count;
    count = 0;
    has_render = 0;
    assert(WebMapSettingsLoad(WORLD, &defaults) == &defaults);
    puts("PASS map settings: validation, original defaults and reload");
    return 0;
}
