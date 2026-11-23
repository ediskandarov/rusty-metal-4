#include <libgte.h>
#include "widescreen.h"
#include "level.h"
#include "tm4/main/game.h"
#include "tm4/main/render.h"
#include <emscripten.h>
#include <libgpu.h>
#include <stdint.h>
#include <string.h>
#ifndef TM4_STANDALONE
#include <psyz/video.h>
#endif

static int active;
static PsyzRect draw_area = { 0, 0, 320, 240 };
static double projection_scale = 1;
static double visible_width = 320;
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
        if (!active)
            draw_area = (PsyzRect) { 0, 0, 320, 240 };
        EM_ASM({ globalThis.tm4Port.widescreen = !!$0; }, active);
    }
    if (active) {
        draw_area = Psyz_VideoGetDrawArea();
        /* PsyZ expands a centred, eight-pixel-aligned canvas. Compensate for
         * its integer pixel scale to preserve the original vertical view. */
        int pixel_scale = size.h / 240;
        if (size.w / 320 < pixel_scale)
            pixel_scale = size.w / 320;
        if (pixel_scale < 1)
            pixel_scale = 1;
        projection_scale = (double)size.h / (pixel_scale * 240);
        visible_width = (double)size.w / pixel_scale;
    }
#endif
}

PsyzRect WebWidescreenDrawArea(void) { return draw_area; }

void WebWidescreenFitBackdrop(TILE* tile)
{
    setXY0(tile, draw_area.sx, draw_area.sy);
    setWH(tile, draw_area.ex - draw_area.sx, draw_area.ey - draw_area.sy);
}

/* SetDrawEnv appends an optional background TILE after its six GPU state
 * commands. Its clip expands in PsyZ's native canvas, but the TILE does not. */
static void update_view_background(DR_ENV* environment)
{
    if (getlen(environment) != 9 || (environment->code[6] >> 24) != 0x60)
        return;
    environment->code[7] = (u16)draw_area.sx | ((u32)(u16)draw_area.sy << 16);
    environment->code[8]
        = (u16)(draw_area.ex - draw_area.sx) | ((u32)(u16)(draw_area.ey - draw_area.sy) << 16);
}

void WebWidescreenBeginDraw(void)
{
    /* Match results use the draw buffer; view environments use the display buffer. */
    WebWidescreenFitBackdrop(&RenderGetDrawBuffer()->black_tiles[0]);
    if (GameInfo.player_count == 1) {
        Tm4RenderBuffer* buffer = RenderGetDisplayBuffer();
        if (buffer) {
            update_view_background(&buffer->players[0].world_environment);
            update_view_background(&buffer->players[0].overlay_environment);
        }
    }
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
    return active ? x < draw_area.sx || x > draw_area.ex : (unsigned short)x > original_width;
}

/* HUD packets share an ordering bucket with other overlays. Record only the
 * packets emitted by each named HUD section, without changing their XYs or UVs.
 * Keep both frame buffers: submission can follow a later browser callback. */
enum { HUD_PACKET_BITS = 11, HUD_PACKET_CAPACITY = 1 << HUD_PACKET_BITS };
typedef struct {
    const void* payload;
    enum WebHudAnchor anchor;
} HudPacket;
typedef struct {
    HudPacket packets[HUD_PACKET_CAPACITY];
    unsigned int count;
    const void* boundary;
    float scale, left, top;
} HudBuffer;
static HudBuffer hud_buffers[2];
static HudBuffer* building_hud;
static HudBuffer* drawing_hud;

static unsigned int hud_slot(const void* payload)
{
    uint32_t address = (uintptr_t)payload / sizeof(u_long);
    return (address * UINT32_C(0x9e3779b9)) >> (32 - HUD_PACKET_BITS);
}

void WebWidescreenHudReset(int buffer)
{
    if (buffer >= 0 && buffer < 2)
        memset(&hud_buffers[buffer], 0, sizeof(hud_buffers[buffer]));
}

void WebWidescreenHudBegin(int buffer, const void* ordering)
{
    building_hud = NULL;
    if (buffer < 0 || buffer >= 2)
        return;
    HudBuffer* hud = &hud_buffers[buffer];
    if (!active)
        return;
    building_hud = hud;
    hud->boundary = nextPrim(ordering);
    hud->scale = projection_scale;
    hud->left = 160 - visible_width / 2;
    hud->top = 120 - 120 * projection_scale;
}

void WebWidescreenHudSection(const void* ordering, enum WebHudAnchor anchor)
{
    HudBuffer* hud = building_hud;
    if (hud == NULL)
        return;
    const void* head = nextPrim(ordering);
    for (const void* packet = head; packet != hud->boundary; packet = nextPrim(packet)) {
        if ((uintptr_t)packet == 0xffffff || packet == NULL)
            break;
        const void* payload = (const char*)packet + sizeof(OT_TYPE);
        if (hud->count == HUD_PACKET_CAPACITY - 1)
            break;
        unsigned int slot = hud_slot(payload);
        while (hud->packets[slot].payload != NULL && hud->packets[slot].payload != payload)
            slot = (slot + 1) % HUD_PACKET_CAPACITY;
        if (hud->packets[slot].payload == NULL)
            ++hud->count;
        hud->packets[slot] = (HudPacket) { payload, anchor };
    }
    hud->boundary = head;
}

void WebWidescreenHudSelect(int buffer)
{
    drawing_hud = buffer >= 0 && buffer < 2 ? &hud_buffers[buffer] : NULL;
}

void WebWidescreenHudTransform(const void* payload, float* scale, float* x, float* y)
{
    *scale = 1;
    *x = *y = 0;
    HudBuffer* hud = drawing_hud;
    if (hud == NULL || hud->count == 0)
        return;
    for (unsigned int slot = hud_slot(payload); hud->packets[slot].payload != NULL;
         slot = (slot + 1) % HUD_PACKET_CAPACITY) {
        const HudPacket* packet = &hud->packets[slot];
        if (packet->payload != payload)
            continue;
        *scale = hud->scale;
        *x = packet->anchor == WEB_HUD_BOTTOM_RIGHT ? 320 - hud->left - 320 * *scale : hud->left;
        *y = packet->anchor == WEB_HUD_TOP_LEFT ? hud->top : 240 - hud->top - 240 * *scale;
        return;
    }
}
