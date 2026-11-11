/* Authority inputs arrive through WebNetSetInput, never host devices. */
#include "tm4/main/pad.h"
#include <stdlib.h>
#include <string.h>
PadCache PadJpad[8];
void PadInitPad(void)
{
    memset(PadJpad, 0, sizeof(PadJpad));
}
void PadStopPad(void)
{
}
s32 PadGetPad(s32 capacity)
{
    abort();
}
void PadResetVibration(void)
{
}
void PadInitVibrationDirectory(void)
{
}
void PadSetVibrationEnabled(s32 index, u8 enabled)
{
    if (enabled)
        abort();
}
void PadVibrateNamed(s32 index, char* path)
{
}
void PadVibrateTS(s32 index, char* path, s32 request_index)
{
}
