#include "map_settings.h"
#include <stdio.h>
#include <stdlib.h>

static Tm4WorldSettings render_settings;

static void invalid(const char* path, const char* reason)
{
    fprintf(stderr, "Map settings: %s: %s\n", path, reason);
    abort();
}

static const void* resource(RegistryDirectory* directory, const char* name, s32 type, u32 size)
{
    if (RegGetDirectoryPtrPS(directory, (char*)name))
        invalid(name, "expected a value, got a directory");
    RegistryFile* file = RegGetFilePtrPS(directory, (char*)name);
    if (!file)
        return NULL;
    if (RegGetFileTypeP(file) != type || RegGetFileByteSizeP(file) != size)
        invalid(name, "wrong resource type or byte length");
    const void* bytes = RegGetFileDataP(file);
    if (!bytes)
        invalid(name, "missing payload");
    return bytes;
}

Tm4WorldSettings* WebMapSettingsLoad(RegistryDirectory* world, Tm4WorldSettings* defaults)
{
    Tm4WorldSettings next = *defaults;
    if (RegGetFilePtrPS(world, "renderSettings"))
        invalid("renderSettings", "expected a directory of named settings");
    RegistryDirectory* render = RegGetDirectoryPtrPS(world, "renderSettings");
    if (render) {
        /* Binary RGB plus a required zero byte; the GPU command stays engine-owned. */
        const u8* color = resource(render, "backgroundColor", REG_FILE_TYPE_BINARY, 4);
        if (color) {
            if (color[3])
                invalid("backgroundColor", "expected R, G, B, 0");
            next.background_color.r = color[0];
            next.background_color.g = color[1];
            next.background_color.b = color[2];
        }
    }
    render_settings = next;
    return render ? &render_settings : defaults;
}
