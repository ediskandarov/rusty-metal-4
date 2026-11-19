#include "src/modules/cars/auger/private.h"
#include "../../overlays.h"
#include <string.h>

static void construct_class(RegistryDirectory* directory)
{
    OSRegisterSoundEmitter();
    OSRegisterCarPhysics();
    OSRegisterCarDisplay();
    CarAugerClassConstructor(directory);
}

OSWord WebAugerExport(const char* name)
{
    return !strcmp(name, "CarAugerClassConstructor") ? (OSWord)construct_class : 0;
}
