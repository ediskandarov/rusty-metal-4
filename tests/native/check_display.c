#include <emscripten.h>
#include <libetc.h>
#include <libgpu.h>
#include <psyz/video.h>

static DISPENV display;

EMSCRIPTEN_KEEPALIVE void WebTestScreenPosition(int x, int y)
{
    display.screen.x = x;
    display.screen.y = y;
}

EMSCRIPTEN_KEEPALIVE void WebTestNativeDisplay(int enabled)
{
    Psyz_VideoSetResolution(enabled ? (PsyzSize) { 320, 240 } : PSYZ_DEFAULT_RESOLUTION);
}

static void frame(void)
{
    PutDispEnv(&display);
    DrawSync(0);
    VSync(0);
    EM_ASM({ globalThis.tm4DisplayPosition = ([ $0, $1 ]); }, display.screen.x, display.screen.y);
}

int main(void)
{
    ResetGraph(0);
    SetVideoMode(MODE_NTSC);
    SetDefDispEnv(&display, 0, 0, 320, 240);
    display.screen.w = 256;
    display.screen.h = 240;
    PutDispEnv(&display);
    DRAWENV draw;
    SetDefDrawEnv(&draw, 0, 0, 320, 240);
    draw.isbg = 0;
    PutDrawEnv(&draw);
    RECT full = { 0, 0, 320, 240 };
    ClearImage(&full, 0, 0, 248);
    TILE tile;
    setTile(&tile);
    setXY0(&tile, 80, 60);
    setWH(&tile, 40, 20);
    setRGB0(&tile, 248, 0, 0);
    DrawPrim(&tile);
    DrawSync(0);
    SetDispMask(1);
    emscripten_set_main_loop(frame, 0, 1);
    return 0;
}
