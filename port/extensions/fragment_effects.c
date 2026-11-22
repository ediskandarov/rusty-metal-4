#include "fragment_effects_runtime.h"
#include "tm4/main/os.h"
#include "tm4/main/registry.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const Rm4FragmentEffects* effects;

void WebFragmentEffectsLoad(void)
{
    effects = NULL;
    RegistryFile* file = RegGetFilePtrS("/world/fragmentEffects");
    if (!file)
        return;
    if (RegGetFileTypeP(file) != REG_FILE_TYPE_STRING) {
        fprintf(stderr, "world/fragmentEffects must be a symbol string\n");
        abort();
    }
    const char* name = RegGetFileDataP(file);
    u32 bytes = RegGetFileByteSizeP(file);
    if (!name || !bytes || !name[0] || !memchr(name, 0, bytes)) {
        fprintf(stderr, "world/fragmentEffects must contain a nonempty terminated symbol\n");
        abort();
    }
    const Rm4FragmentEffects* candidate = (void*)OSSymbolGetAddress((char*)name);
    if (!candidate || candidate->version != RM4_FRAGMENT_EFFECTS_VERSION
        || candidate->size != sizeof(*candidate) || !candidate->impact) {
        fprintf(stderr, "Invalid fragment effects provider: %s\n", name);
        abort();
    }
    effects = candidate;
}

void WebFragmentEffectsUnload(void)
{
    effects = NULL;
}

int WebFragmentEffectsImpact(
    const SVECTOR* position, int32_t size, int32_t material, int32_t surface_kind)
{
    if (!effects)
        return 0;
    const Rm4FragmentImpact event = {
        .position = { position->vx, position->vy, position->vz, 0 },
        .effect_size = size,
        .material = material,
        .surface_kind = surface_kind,
    };
    effects->impact(&event);
    return 1;
}
