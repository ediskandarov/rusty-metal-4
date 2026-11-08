#include "tm4/main/os.h"

OSWord WebCarObjectExport(const char* name);

OSWord WebCarExport(const char* name)
{
    return WebCarObjectExport(name);
}
