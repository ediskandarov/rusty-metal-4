/* Simulation-only PsyZ endpoints. No window, device, event pump or audio callback. */
#include "draw.h"
#include "subpixel.h"
#include <emscripten.h>
#include <libgpu.h>
#include <psyz/audio.h>
#include <psyz/overlay.h>
#include <psyz/video.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static _Noreturn void unavailable(const char* endpoint)
{
    fprintf(stderr, "Headless endpoint is unavailable: %s\n", endpoint);
    abort();
}

#ifdef TM4_STANDALONE
void Psyz_WebWaitForNextFrame(double delay_ms)
{
    unavailable(__func__);
}
#endif

void psyz_log(
    unsigned level, const char* file, unsigned line, const char* func, const char* fmt, ...)
{
    if (level < 2)
        return;
    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    fputc('\n', stderr);
    va_end(args);
}
uint32_t Psyz_OsNowUs(void)
{
#ifdef TM4_STANDALONE
    WebHeadlessRequireHost(__func__, __FILE__, __LINE__);
#else
    return (uint32_t)(emscripten_get_now() * 1000);
#endif
}
uintptr_t Psyz_OsThreadSelf(void)
{
    return 1;
}
void* Psyz_OsLockCreate(void)
{
    return malloc(1);
}
void Psyz_OsLock(void* lock)
{
    (void)lock;
}
void Psyz_OsUnlock(void* lock)
{
    (void)lock;
}
void* Psyz_OsBellCreate(void)
{
    return malloc(1);
}
void Psyz_OsBellRing(void* bell)
{
    (void)bell;
}
void Psyz_OsBellWait(void* bell, uint32_t timeout)
{
    unavailable(__func__);
}
int Psyz_OsThreadStart(void (*fn)(void), const char* name)
{
    return -1;
}
int Psyz_AudioInit(void)
{
    unavailable(__func__);
}
void Psyz_AudioDestroy(void)
{
}
void Psyz_AudioPause(void)
{
}
void Psyz_AudioUnpause(void)
{
    unavailable(__func__);
}
void Psyz_AudioLock(void)
{
}
void Psyz_AudioUnlock(void)
{
}
void MyPadInit(int mode)
{
}
void Psyz_PadsPoll(void)
{
    unavailable(__func__);
}
void ResetPlatform(void)
{
}
int Psyz_QuitRequested(void)
{
    return 0;
}
void Psyz_SetTitle(const char* title)
{
}
unsigned Psyz_VideoGetInternalResolution(void)
{
    return 1;
}
int Psyz_VideoSetInternalResolution(unsigned multiplier)
{
    return 0;
}
int Psyz_VideoSetVsyncMode(PsyzVsyncMode mode)
{
    return 0;
}
PsyzVsyncMode Psyz_VideoGetVsyncMode(void)
{
    return PSYZ_VSYNC_LIMITLESS;
}
int Psyz_VideoSetDitheringMode(PsyzDitherMode mode)
{
    return 0;
}
PsyzDitherMode Psyz_VideoGetDitheringMode(void)
{
    return PSYZ_DITHER_OFF;
}
PsyzSize Psyz_VideoGetDisplaySize(void)
{
    return (PsyzSize) { 320, 240 };
}
PsyzRect Psyz_VideoGetDrawArea(void)
{
    return (PsyzRect) { 0, 0, 320, 240 };
}
void Psyz_VideoPresentFrame(void)
{
    unavailable(__func__);
}
int Psyz_VideoVSync(int mode)
{
    if (mode >= 0)
        unavailable(__func__);
    return 0;
}
void Draw_Reset(void)
{
}
void Draw_DisplayEnable(unsigned on)
{
}
void Draw_DisplayArea(unsigned x, unsigned y)
{
}
void Draw_DisplayHorizontalRange(unsigned start, unsigned end)
{
}
void Draw_DisplayVerticalRange(unsigned start, unsigned end)
{
}
void Draw_SetDisplayMode(DisplayMode* mode)
{
}
void Draw_SetTexpageMode(ParamDrawTexpageMode* mode)
{
}
void Draw_SetTextureWindow(unsigned x, unsigned y, unsigned ox, unsigned oy)
{
}
void Draw_SetAreaStart(int x, int y)
{
}
void Draw_SetAreaEnd(int x, int y)
{
}
void Draw_SetOffset(int x, int y)
{
}
int Draw_SetHorizontalGrid(unsigned source, unsigned target)
{
    return 0;
}
void Draw_SetMask(int a, int b)
{
}
void Draw_ClearImage(RECT* rect, u_char r, u_char g, u_char b)
{
}
void Draw_LoadImage(RECT* rect, u_long* p)
{
}
void Draw_StoreImage(RECT* rect, u_long* p)
{
    unavailable(__func__);
}
void Draw_MoveImage(RECT* rect, unsigned x, unsigned y)
{
}
void Draw_PutDispEnv(DISPENV* disp)
{
}
void Draw_ResetBuffer(void)
{
}
void Draw_FlushBuffer(void)
{
}
int Draw_PushPrim(u_long* packets, int max_len)
{
    unavailable(__func__);
}
int Psyz_DrawPushPrimWithPositions(
    u_long* packets, int max_len, const PsyzSubpixelPosition* positions, unsigned options)
{
    unavailable(__func__);
}
int Draw_ExequeSync(void)
{
    return 0;
}
PsyzOverlayFrameCB Psyz_OverlayFrameCB(PsyzOverlayFrameCB callback)
{
    return NULL;
}
