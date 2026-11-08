#include "../../overlays.h"
#include "tm4/main/os.h"
#include "tm4/main/registry.h"
#include "tm4/modules/car.h"
#include <string.h>

void CarPirateClassConstructor(RegistryDirectory* directory);
s32 CarPirateProcess(Car* car, void* state);
MATRIX* CarPirateDisplaySpecialGroupDisplay(
    Car* car, s32 number, CarRenderGroup* group, MATRIX* transform, void* state);
extern s32 CarPirateSizeof;
extern CarNameEntry CarPirateDisplayGroupTranslations[];

OSWord WebPirateExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
#undef EXPORT
    return 0;
}
