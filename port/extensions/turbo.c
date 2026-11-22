#include "turbo.h"
#include "tm4/main/object.h"
#include "tm4/main/registry.h"
#include "tm4/modules/car.h"
#include "turbo_runtime.h"
#include <stdio.h>
#include <string.h>

static const char* string(RegistryDirectory* directory, char* key)
{
    RegistryFile* file = RegGetFilePtrPS(directory, key);
    if (!file || RegGetFileTypeP(file) != REG_FILE_TYPE_STRING)
        return NULL;
    const char* value = RegGetFileDataP(file);
    u32 size = RegGetFileByteSizeP(file);
    return value && size > 1 && value[0] && memchr(value, 0, size) ? value : NULL;
}

int WebTurboLoad(Car* car)
{
    car->turbo_profile = NULL;
    car->turbo_position = (SVECTOR) { 0 };
    RegistryDirectory* settings = RegGetDirectoryPtrS("turboEffect");
    if (!settings) {
        if (RegGetFilePtrS("turboEffect"))
            goto invalid;
        return 1;
    }
    const char* path = string(settings, "profile");
    if (!path || path[0] != '/')
        goto invalid;
    RegistryDirectory* profile = RegGetDirectoryPtrS((char*)path);
    if (!profile || !string(profile, "class"))
        goto invalid;
    if (RegGetDirectoryPtrPS(settings, "position"))
        goto invalid;
    RegistryFile* position = RegGetFilePtrPS(settings, "position");
    if (position) {
        if (RegGetFileTypeP(position) != 26 || RegGetFileByteSizeP(position) != sizeof(SVECTOR)
            || RegGetFileArraySizeP(position) != 1)
            goto invalid;
        const SVECTOR* value = RegGetFileDataP(position);
        car->turbo_position = (SVECTOR) { value->vx, value->vy, value->vz, 0 };
    }
    car->turbo_profile = profile;
    return 1;
invalid:
    fprintf(stderr, "Invalid turboEffect profile or mount for car %s\n", car->character_name);
    return 0;
}

int WebTurboAttach(Car* car)
{
    if (!car->turbo_profile)
        return 1;
    const char* name = string(car->turbo_profile, "class");
    if (!name)
        return 0;
    /* Reserved engine lists would break the after-owner processing contract. */
    for (s32 i = 0; i < OBJECT_LIST_COUNT; ++i)
        if (i != OBJECT_LIST_DEFAULT && !strcmp(name, ObjectLists[i].name))
            return 0;
    Rm4TurboAppearanceContext context = { car->turbo_profile, car->turbo_position };
    if (ObjectCreate((char*)name, OBJECT_HAS_OWNER | OBJECT_DESTROY_WITH_OWNER, car, &context))
        return 1;
    fprintf(stderr, "Could not create turbo appearance class: %s\n", name);
    return 0;
}
