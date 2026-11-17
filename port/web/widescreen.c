#include <libgte.h>
#include "widescreen.h"
#include "level.h"
#include "tm4/main/game.h"
#include <emscripten.h>
#ifndef TM4_STANDALONE
#include <psyz/video.h>
#endif

static int active;
static int left;
static int right = 320;
static double projection_scale = 1;
static int saved_x, saved_y;
static long saved_projection;
static int drawing;

void WebWidescreenUpdate(void)
{
#ifndef TM4_STANDALONE
    static PsyzSize requested;
    PsyzSize size = { 0, 0 };
    if (WebLevelActive() && GameInfo.player_count == 1
        && EM_ASM_INT({ return !!document.fullscreenElement; })) {
        size = Psyz_VideoGetDisplaySize();
        /* Portrait and narrow displays retain the original framed view. */
        if (size.w * 3 <= size.h * 4)
            size = (PsyzSize) { 0, 0 };
    }
    if (size.w != requested.w || size.h != requested.h) {
        Psyz_VideoSetAnchor(PSYZ_ANCHOR_CENTER);
        if (Psyz_VideoSetResolution(size) != 0)
            return;
        requested = size;
        active = size.w != 0;
        EM_ASM({ globalThis.tm4Port.widescreen = !!$0; }, active);
    }
    if (active) {
        PsyzRect area = Psyz_VideoGetDrawArea();
        left = area.sx;
        right = area.ex;
        /* PsyZ expands a centred, eight-pixel-aligned canvas. Compensate for
         * its integer pixel scale to preserve the original vertical view. */
        int pixel_scale = size.h / 240;
        if (size.w / 320 < pixel_scale)
            pixel_scale = size.w / 320;
        if (pixel_scale < 1)
            pixel_scale = 1;
        projection_scale = (double)size.h / (pixel_scale * 240);
    }
#endif
}

void WebWidescreenBeginDraw(void)
{
    drawing = active;
    if (!drawing)
        return;
    saved_projection = ReadGeomScreen();
    ReadGeomOffset(&saved_x, &saved_y);
    SetGeomScreen((long)(saved_projection * projection_scale + 0.5));
    SetGeomOffset(
        160 + (saved_x - 160) * projection_scale, 120 + (saved_y - 120) * projection_scale);
}

void WebWidescreenEndDraw(void)
{
    if (!drawing)
        return;
    /* Projection changes belong to rendering, never to the next simulation tick. */
    SetGeomScreen(saved_projection);
    SetGeomOffset(saved_x, saved_y);
    drawing = 0;
}

int WebWidescreenClipX(int x, unsigned int original_width)
{
    return active ? x < left || x > right : (unsigned short)x > original_width;
}
