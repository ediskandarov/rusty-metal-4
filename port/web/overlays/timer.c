#include "tm4/modules/timer.h"
#include "../overlays.h"
#include "port/web/browser_report.h"
#include <string.h>

static s32 construct(void* object, va_list args)
{
    s32 result = TimerConstructor(object, args);
    if (result)
        WEB_BROWSER_REPORT({ tm4Port.timerSpawns = (tm4Port.timerSpawns || 0) + 1; });
    return result;
}

OSWord WebTimerExport(const char* name)
{
    if (!strcmp(name, "TimerSizeof"))
        return (OSWord)&TimerSizeof;
    if (!strcmp(name, "TimerConstructor"))
        return (OSWord)construct;
    if (!strcmp(name, "TimerProcess"))
        return (OSWord)TimerProcess;
    return 0;
}
