#include "overlays.h"
/* Native import bindings and platform edges for the original menu. */
#include "src/modules/menu/private.h"
#include "level.h"
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
    Import_SoundEmitterSetVolumeFade = SoundEmitterSetVolumeFade;
    Import_SoundEmitterSetPitchScale = SoundEmitterSetPitchScale;
    Import_SoundEmitterSetVolumeScale = SoundEmitterSetVolumeScale;
}

OSWord WebCarExport(const char* name);

static s32 construct_camera(void* object, va_list arguments)
{
    return CameraConstructor(object, arguments);
}

static void process_camera(void* object)
{
    CameraProcess(object);
}

static void destroy_camera(void* object)
{
    CameraDestructor(object);
}

OSWord OSSymbolGetAddress(char* name)
{
#define EXPORT(symbol)                                                                             \
    if (!strcmp(name, #symbol))                                                                    \
    return (OSWord)symbol
    EXPORT(MenuRelocateCarTextures);
    if (!strcmp(name, "CameraSizeof"))
        return (OSWord)&CameraSizeof;
    if (!strcmp(name, "CameraConstructor"))
        return (OSWord)construct_camera;
    if (!strcmp(name, "CameraProcess"))
        return (OSWord)process_camera;
    if (!strcmp(name, "CameraDestructor"))
        return (OSWord)destroy_camera;
    if (!strcmp(name, "SoundEmitterSizeof"))
        return (OSWord)&SoundEmitterSizeof;
    if (!strcmp(name, "SoundEmitterClassConstructor"))
        return (OSWord)SoundEmitterClassConstructor;
    EXPORT(SoundEmitterConstructor);
    EXPORT(SoundEmitterInstanceConstructor);
    EXPORT(SoundEmitterProcess);
    EXPORT(SoundEmitterDestructor);
    EXPORT(SoundEmitterSetVolumeFade);
    EXPORT(SoundEmitterSetPitchScale);
    EXPORT(SoundEmitterSetVolumeScale);
#undef EXPORT
    OSWord result = WebCarExport(name);
    if (!result && WebNativeModuleLoaded("o_weap.sym"))
        result = WebWeaponExport(name);
    if (!result && WebNativeModuleLoaded("interact.sym"))
        result = WebInteractExport(name);
    if (!result && WebNativeModuleLoaded("o_carprt.sym"))
        result = WebCarpartExport(name);
    if (!result && WebNativeModuleLoaded("o_afc.sym"))
        result = WebAfcExport(name);
    if (!result && WebNativeModuleLoaded("o_power.sym"))
        result = WebPowerExport(name);
    if (!result && WebNativeModuleLoaded("o_timer.sym"))
        result = WebTimerExport(name);
    if (!result && WebNativeModuleLoaded("o_bullet.sym"))
        result = WebBulletExport(name);
    if (!result && WebNativeModuleLoaded("o_ray.sym"))
        result = WebRayExport(name);
    if (!result && WebNativeModuleLoaded("o_fire.sym"))
        result = WebFireExport(name);
    if (!result && WebNativeModuleLoaded("o_firing.sym"))
        result = WebFireRingExport(name);
    if (!result && WebNativeModuleLoaded("o_destry.sym"))
        result = WebDestroyableExport(name);
    if (!result && WebNativeModuleLoaded("o_frag.sym"))
        result = WebFragmentExport(name);
    if (!result && WebNativeModuleLoaded("o_tele.sym"))
        result = WebTeleporterExport(name);
    if (!result && WebNativeModuleLoaded("o_jump.sym"))
        result = WebJumppadExport(name);
    if (!result && WebNativeModuleLoaded("o_light.sym"))
        result = WebLightExport(name);
    if (!result && WebNativeModuleLoaded("o_lightn.sym"))
        result = WebLightningExport(name);
    if (!result && WebNativeModuleLoaded("o_anim.sym"))
        result = WebAnimExport(name);
    if (!result && WebNativeModuleLoaded("o_expl.sym"))
        result = WebExplExport(name);
    if (!result && WebNativeModuleLoaded("c_pirate.sym"))
        result = WebPirateExport(name);
    if (!result && WebNativeModuleLoaded("w_yard.sym"))
        result = WebYardExport(name);
    if (!result && WebNativeModuleLoaded("c_auger.sym"))
        result = WebAugerExport(name);
    if (!result && WebNativeModuleLoaded("w_neon.sym"))
        result = WebNeonExport(name);
    if (!result && WebNativeModuleLoaded("w_carni.sym"))
        result = WebCarnivalExport(name);
    if (!result && WebNativeModuleLoaded("w_oil.sym"))
        result = WebOilExport(name);
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
