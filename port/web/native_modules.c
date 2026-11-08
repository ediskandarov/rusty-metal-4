#include "car.h"
#include "overlays.h"
#include "tm4/main/registry.h"
#include <string.h>

/* Registry ownership removes these markers with the original MR registration. */
static char module_directory[] = "/nativeModules";

static s32 install_module(char* path, s32 type, s32 size, void* data, char* registration)
{
    const u32* header = data;
    if (size < 20 || header[4] >= (u32)size)
        return 0;
    const char* start = (const char*)data + header[4];
    const char* end = memchr(start, '*', size - header[4]);
    if (!end || end - start >= 128)
        return 0;
    char image_name[128];
    memcpy(image_name, start, end - start);
    image_name[end - start] = 0;
    if (strchr(image_name, '/') || strchr(image_name, '\\'))
        return 0;
    RegistryDirectory* directory = RegGetDirectoryPtrS(module_directory);
    u32 present = 1;
    s32 installed = RegistryCreateFilePS(
        directory, image_name, &present, sizeof(present), REG_FILE_TYPE_BINARY, registration);
    if (installed && !strcmp(image_name, "o_car.sym"))
        WebCarResetSearchState();
    return installed;
}

void WebNativeModulesInitialize(void)
{
    RegCreateDirectoryPS(RegGetDirectoryPtrS("/"), module_directory, "native");
    RegistrySetTypeHandler(REG_FILE_TYPE_RELMOD, install_module);
}

int WebNativeModuleLoaded(const char* image_name)
{
    RegistryDirectory* directory = RegGetDirectoryPtrS(module_directory);
    return directory && RegGetFileDataPS(directory, (char*)image_name) != NULL;
}
