#include "module_image.h"
#ifndef TM4_STANDALONE
#include <emscripten.h>
#endif
#include "car.h"
#include "module_import.h"
#include "overlays.h"
#include "snapshot_types.h"
#include "tm4/main/object.h"
#include "tm4/main/registry.h"
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Registry ownership removes these markers with the original MR registration.
 */
static u32 module_generation = 1;

OSWord WebResolveModuleImport(WebModuleImport* binding)
{
    if (binding->generation != module_generation) {
        /* Return the defining module's address, not a loader-created import
     * trampoline. */
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
typedef struct NativeModule {
    struct NativeModule* next;
    char image[128];
    void* handle;
    ModuleExport lookup;
    void* bytes;
    s32 size;
} NativeModule;
static NativeModule* modules;

#ifdef TM4_STANDALONE
__attribute__((import_module("env"), import_name("rm4_validate_module"))) extern void
validate_module(const char* path, const void* bytes, unsigned size);
#endif

static void module_file(const char* path, const void* bytes, s32 size)
{
#ifndef TM4_STANDALONE
    EM_ASM(
        {
            const path = UTF8ToString($0);
            if ($1) {
                FS.mkdirTree("/mr");
                FS.writeFile(path, HEAPU8.subarray($1, $1 + $2));
            } else {
                FS.unlink(path);
            }
        },
        path, bytes, size);
#else
    if (bytes)
        validate_module(path, bytes, size);
#endif
}

OSWord WebDynamicModuleExport(const char* image, const char* name)
{
    for (NativeModule* module = modules; module; module = module->next)
        if (!strcmp(image, module->image) && module->lookup && WebNativeModuleLoaded(image))
            return module->lookup(name);
    return 0;
}

OSWord WebResourceModuleExport(const char* name)
{
    for (NativeModule* module = modules; module; module = module->next) {
        OSWord result = WebDynamicModuleExport(module->image, name);
        if (result)
            return result;
    }
    return 0;
}

const SnapshotType* WebNativeSnapshotType(const char* name)
{
    for (NativeModule* module = modules; module; module = module->next) {
        const SnapshotType* types
            = (void*)WebDynamicModuleExport(module->image, "__rm4_snapshot_types");
        for (const SnapshotType* type = types; type && type->name; ++type)
            if (!strcmp(type->name, name))
                return type;
    }
    return NULL;
}

void WebNativeModulesSweep(void)
{
    for (NativeModule* module = modules; module; module = module->next) {
        if (module->handle && !WebNativeModuleLoaded(module->image)) {
            WebSnapshotUnregisterTypes((void*)module->lookup("__rm4_snapshot_types"));
            ++module_generation;
            dlclose(module->handle);
            module->handle = NULL;
            module->lookup = NULL;
            char filename[160];
            snprintf(filename, sizeof(filename), "/mr/%s", module->image);
            module_file(filename, NULL, 0);
        }
    }
}

static s32 install_module(char* path, s32 type, s32 size, void* data, char* registration)
{
    char image[128];
    if (size < 0 || !WebModuleImageName(data, size, image)) {
        fprintf(stderr, "Invalid Wasm MR entry: %s\n", path);
        abort();
    }
    NativeModule* module = modules;
    while (module && strcmp(module->image, image))
        module = module->next;
    if (module && (module->size != size || memcmp(module->bytes, data, size))) {
        fprintf(stderr, "Resource module identity changed: %s\n", image);
        abort();
    }
    if (!module) {
        module = calloc(1, sizeof(*module));
        if (!module)
            abort();
        module->bytes = malloc(size);
        if (!module->bytes) {
            free(module);
            abort();
        }
        memcpy(module->bytes, data, size);
        module->size = size;
        strcpy(module->image, image);
        module->next = modules;
        modules = module;
    }
    if (!module->handle) {
        char filename[160];
        snprintf(filename, sizeof(filename), "/mr/%s", image);
        module_file(filename, data, size);
        void* handle = dlopen(filename, RTLD_NOW | RTLD_LOCAL);
        if (!handle) {
            fprintf(stderr, "Cannot load %s: %s\n", image, dlerror());
            module_file(filename, NULL, 0);
            abort();
        }
        ModuleExport lookup = (ModuleExport)dlsym(handle, "Tm4ModuleExport");
        if (!lookup) {
            dlclose(handle);
            module_file(filename, NULL, 0);
            abort();
        }
        module->handle = handle;
        module->lookup = lookup;
        ++module_generation;
    }
    RegistryDirectory* directory = RegGetDirectoryPtrS(module_directory);
    if (!directory) {
        WebNativeModulesSweep();
        abort();
    }
    RegCreateDirectoryPS(directory, image, "native");
    directory = RegGetDirectoryPtrPS(directory, image);
    if (!directory) {
        WebNativeModulesSweep();
        abort();
    }
    u32 present = 1;
    char* owner = registration ? registration : "permanent";
    if (!RegGetFileDataPS(directory, owner))
        RegistryCreateFilePS(
            directory, owner, &present, sizeof(present), REG_FILE_TYPE_BINARY, registration);
    s32 installed = RegGetFileDataPS(directory, owner) != NULL;
    if (!installed) {
        WebNativeModulesSweep();
        fprintf(stderr, "Cannot register module owner: %s\n", image);
        abort();
    }
    if (installed && !strcmp(image, "o_car.sym"))
        WebCarResetSearchState();
    if (installed && !strcmp(image, "o_sound.sym")) {
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
