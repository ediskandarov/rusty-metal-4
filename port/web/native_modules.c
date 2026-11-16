#include "module_import.h"
#include "car.h"
#include "overlays.h"
#include "snapshot_types.h"
#include "tm4/main/object.h"
#include "tm4/main/registry.h"
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Registry ownership removes these markers with the original MR registration. */
static u32 module_generation = 1;

OSWord WebResolveModuleImport(WebModuleImport* binding)
{
    if (binding->generation != module_generation) {
        /* Return the defining module's address, not a loader-created import trampoline. */
        binding->address = !strcmp(binding->module, "main")
            ? (!strcmp(binding->symbol, "ObjectDestroy") ? (OSWord)ObjectDestroy : 0)
            : WebNativeModuleExport(binding->module, binding->symbol);
        if (!binding->address) {
            fprintf(stderr, "Missing module import: %s:%s\n", binding->module, binding->symbol);
            abort();
        }
        binding->generation = module_generation;
    }
    return binding->address;
}

static char module_directory[] = "/nativeModules";
typedef OSWord (*ModuleExport)(const char*);
static struct {
    const char* image;
    void* handle;
    ModuleExport lookup;
} modules[] = {
#include "modules.inc"
};

OSWord WebDynamicModuleExport(const char* image, const char* name)
{
    for (unsigned i = 0; i < sizeof(modules) / sizeof(*modules); ++i)
        if (!strcmp(image, modules[i].image) && modules[i].lookup && WebNativeModuleLoaded(image))
            return modules[i].lookup(name);
    return 0;
}

const SnapshotType* WebNativeSnapshotType(const char* name)
{
    for (unsigned i = 0; i < sizeof(modules) / sizeof(*modules); ++i) {
        const SnapshotType* types
            = (void*)WebDynamicModuleExport(modules[i].image, "__rm4_snapshot_types");
        for (const SnapshotType* type = types; type && type->name; ++type)
            if (!strcmp(type->name, name))
                return type;
    }
    return NULL;
}

void WebNativeModulesSweep(void)
{
    for (unsigned i = 0; i < sizeof(modules) / sizeof(*modules); ++i) {
        if (modules[i].handle && !WebNativeModuleLoaded(modules[i].image)) {
            WebSnapshotUnregisterTypes((void*)modules[i].lookup("__rm4_snapshot_types"));
            ++module_generation;
            dlclose(modules[i].handle);
            modules[i].handle = NULL;
            modules[i].lookup = NULL;
        }
    }
}

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
    int known = 0;
    for (unsigned i = 0; i < sizeof(modules) / sizeof(*modules); ++i) {
        if (!strcmp(image_name, modules[i].image))
            known = 1;
        if (strcmp(image_name, modules[i].image) || modules[i].handle)
            continue;
        char filename[160];
        snprintf(filename, sizeof(filename), "/modules/%.*s.wasm", (int)strlen(image_name) - 4,
            image_name);
        void* handle = dlopen(filename, RTLD_NOW | RTLD_LOCAL);
        if (!handle) {
            fprintf(stderr, "Cannot load %s: %s\n", filename, dlerror());
            return 0;
        }
        ModuleExport lookup = (ModuleExport)dlsym(handle, "Tm4ModuleExport");
        if (!lookup) {
            dlclose(handle);
            return 0;
        }
        modules[i].handle = handle;
        modules[i].lookup = lookup;
        ++module_generation;
    }
    /* Movie playback is a browser-owned frame loop (movie.c), not the PS1 CD interrupt loop. */
    if (!strcmp(image_name, "movie_r.sym"))
        return 1;
    if (!known) {
        fprintf(stderr, "Unknown resource module: %s\n", image_name);
        return 0;
    }
    RegistryDirectory* directory = RegGetDirectoryPtrS(module_directory);
    RegCreateDirectoryPS(directory, image_name, "native");
    directory = RegGetDirectoryPtrPS(directory, image_name);
    u32 present = 1;
    char* owner = registration ? registration : "permanent";
    if (!RegGetFileDataPS(directory, owner))
        RegistryCreateFilePS(
            directory, owner, &present, sizeof(present), REG_FILE_TYPE_BINARY, registration);
    s32 installed = RegGetFileDataPS(directory, owner) != NULL;
    if (!installed)
        WebNativeModulesSweep();
    if (installed && !strcmp(image_name, "o_car.sym"))
        WebCarResetSearchState();
    if (installed && !strcmp(image_name, "o_sound.sym")) {
        extern void SoundResolveEmitterSymbols(void);
        SoundResolveEmitterSymbols();
    }
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
    directory = directory ? RegGetDirectoryPtrPS(directory, (char*)image_name) : NULL;
    return directory && RegGetNumberOfFilesP(directory) > 0;
}
