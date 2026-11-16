#include "overlays.h"
#include "port/web/module_import.h"
/* Native import bindings and platform edges for the original menu. */
#include "level.h"
#include "src/modules/menu/private.h"
#include "tm4/main/loading.h"
#include "tm4/main/object.h"
#include "tm4/main/os.h"
#include "tm4/main/redbook.h"
#include "tm4/main/sound.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/sound.h"
#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void MenuRelocateCarTextures(RegistryDirectory*, u16, u16, u16, u16);

void WebMenuBindImports(void)
{
    WEB_MODULE("menu", Import_SoundEmitterSetVolumeFade)
        = WEB_MODULE("sound", SoundEmitterSetVolumeFade);
    WEB_MODULE("menu", Import_SoundEmitterSetPitchScale)
        = WEB_MODULE("sound", SoundEmitterSetPitchScale);
    WEB_MODULE("menu", Import_SoundEmitterSetVolumeScale)
        = WEB_MODULE("sound", SoundEmitterSetVolumeScale);
}

OSWord WebCarExport(const char* name);

OSWord OSSymbolGetAddress(char* name)
{
    OSWord result = WebCarExport(name);
    if (!result)
        result = WebNativeExport(name);
    return result;
}

void* OSSymbolGetAddressAssert(char* name)
{
    OSWord result = OSSymbolGetAddress(name);
    if (!result) {
        fprintf(stderr, "Missing native export: %s\n", name);
        abort();
    }
    return (void*)result;
}
