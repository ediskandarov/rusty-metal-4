#include <kernel.h>
#include <libapi.h>

/* PsyZ dispatches guest interrupts under its kernel lock. */
void SwEnterCriticalSection(void)
{
    PS1_EnterCriticalSection();
}

void SwExitCriticalSection(void)
{
    PS1_ExitCriticalSection();
}
