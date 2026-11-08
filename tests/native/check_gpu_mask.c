#include <emscripten.h>
#include <libgpu.h>
#include <stdio.h>
#include "port/psyz/subpixel.h"

/* Exercise real packets and VRAM readback, independently of game assets. */
static int failures;

static void mask(int flags)
{
    DR_STP command;
    setlen(&command, 1);
    command.code[0] = 0xe6000000 | flags;
    DrawPrim(&command);
}

static void tile(int x, int red, int green, int blue)
{
    TILE primitive;
    setTile(&primitive);
    setXY0(&primitive, x, 10);
    setWH(&primitive, 2, 2);
    setRGB0(&primitive, red, green, blue);
    DrawPrim(&primitive);
}

static void expect(int x, unsigned short expected, const char* label)
{
    RECT rect = { x, 10, 2, 1 };
    u_long pixels = 0;
    StoreImage(&rect, &pixels);
    DrawSync(0);
    unsigned short actual = pixels & 0xffff;
    printf("%s %s: %04x expected %04x\n", actual == expected ? "PASS" : "FAIL", label, actual,
        expected);
    failures += actual != expected;
}

static void check_dithering(int enabled)
{
    DR_TPAGE mode;
    SetDrawTPage(&mode, 0, enabled, 0);
    DrawPrim(&mode);
    POLY_G4 quad;
    setPolyG4(&quad);
    setXY4(&quad, 100, 40, 104, 40, 100, 44, 104, 44);
    setRGB0(&quad, 128, 128, 128);
    setRGB1(&quad, 128, 128, 128);
    setRGB2(&quad, 128, 128, 128);
    setRGB3(&quad, 128, 128, 128);
    DrawPrim(&quad);
    RECT rect = { 100, 40, 4, 4 };
    u_long pixels[8];
    StoreImage(&rect, pixels);
    DrawSync(0);
    int low = 0, high = 0;
    for (int i = 0; i < 16; ++i) {
        unsigned short pixel = (pixels[i / 2] >> ((i % 2) * 16)) & 0xffff;
        low += pixel == 0x3def;
        high += pixel == 0x4210;
    }
    int valid = enabled ? low > 0 && high > 0 && low + high == 16 : high == 16;
    failures += !valid;
    printf("%s dithering %s: %d darker, %d base pixels\n", valid ? "PASS" : "FAIL",
        enabled ? "enabled" : "disabled", low, high);
}

static void check_perspective(void)
{
    /* At (104, 10), screen barycentrics are (1/2, 1/4, 1/4).
     * UVs (0,0), (24,0), (0,24) give (6,6) with affine interpolation.
     * Depths 1, 2, 4 give (48/11, 24/11), which samples texel (4,2).
     * The red Gouraud channel must still use the screen weights. */
    RECT affine = { 390, 6, 2, 1 };
    RECT corrected = { 388, 2, 2, 1 };
    u_long texels = 0x7fff;
    LoadImage(&affine, &texels);
    texels = 0xffff;
    LoadImage(&corrected, &texels);
    DrawSync(0);

    POLY_GT3 triangle;
    setPolyGT3(&triangle);
    setXY3(&triangle, 100, 6, 116, 6, 100, 22);
    setUV3(&triangle, 0, 0, 24, 0, 0, 24);
    setRGB0(&triangle, 128, 128, 128);
    setRGB1(&triangle, 0, 128, 128);
    setRGB2(&triangle, 0, 128, 128);
    triangle.clut = 0;
    triangle.tpage = GetTPage(2, 0, 384, 0);
    u_long* payload = (u_long*)((char*)&triangle + sizeof(OT_TYPE));
    PsyzSubpixelPosition positions[] = {
        { 100, 6, 1.0f }, { 116, 6, 0.5f }, { 100, 22, 0.25f },
    };

    Psyz_DrawPushPrimWithPositions(payload, getlen(&triangle), positions, 0);
    expect(104, 0x7fef, "affine UV and Gouraud interpolation");
    Psyz_DrawPushPrimWithPositions(
        payload, getlen(&triangle), positions, PSYZ_PERSPECTIVE_TEXTURES);
    expect(104, 0xffef, "perspective UV and affine Gouraud interpolation");
    mask(2);
    tile(104, 0, 0, 248);
    expect(104, 0xffef, "perspective texel still protects its mask bit");
    mask(0);

    positions[2].inv_depth = 0.0f;
    Psyz_DrawPushPrimWithPositions(
        payload, getlen(&triangle), positions, PSYZ_PERSPECTIVE_TEXTURES);
    expect(104, 0x7fef, "one invalid depth selects affine for the whole polygon");
}

int main(void)
{
    ResetGraph(0);
    DRAWENV draw;
    SetDefDrawEnv(&draw, 0, 0, 320, 240);
    draw.isbg = 0;
    PutDrawEnv(&draw);
    mask(0);
    tile(10, 248, 0, 0);
    expect(10, 0x001f, "untextured writes no mask");
    mask(1);
    tile(12, 0, 248, 0);
    expect(12, 0x83e0, "forced mask");
    mask(2);
    tile(10, 0, 0, 248);
    tile(12, 0, 0, 248);
    expect(10, 0x7c00, "unmasked pixel accepts drawing");
    expect(12, 0x83e0, "masked pixel rejects drawing");
    mask(0);
    tile(12, 248, 0, 0);
    expect(12, 0x001f, "disabled protection replaces and clears mask");
    RECT source = { 64, 10, 2, 1 };
    u_long texels = 0x001f801f;
    mask(0);
    LoadImage(&source, &texels);
    SPRT sprite;
    setSprt(&sprite);
    setXY0(&sprite, 20, 10);
    setWH(&sprite, 2, 1);
    setUV0(&sprite, 0, 10);
    setRGB0(&sprite, 128, 128, 128);
    sprite.clut = 0;
    DR_TPAGE page;
    SetDrawTPage(&page, 0, 0, GetTPage(2, 0, 64, 0));
    DrawPrim(&page);
    DrawPrim(&sprite);
    expect(20, 0x801f, "textured opaque preserves STP");
    expect(21, 0x001f, "textured opaque preserves clear STP");
    mask(1);
    LoadImage(&source, &texels);
    expect(65, 0x801f, "upload forces mask");
    mask(2);
    texels = 0x03e003e0;
    LoadImage(&source, &texels);
    expect(64, 0x801f, "upload respects protected destination");
    mask(0);
    tile(30, 0, 0, 248);
    mask(1);
    RECT from = { 30, 10, 2, 1 };
    MoveImage(&from, 32, 10);
    expect(32, 0xfc00, "VRAM copy forces mask");
    mask(2);
    tile(30, 248, 0, 0);
    MoveImage(&from, 32, 10);
    expect(32, 0xfc00, "VRAM copy respects protected destination");
    // Test command ordering within a single OT, not just individual DrawPrim calls.
    TILE first, second;
    setTile(&first);
    setXY0(&first, 40, 10);
    setWH(&first, 2, 2);
    setRGB0(&first, 248, 0, 0);
    setTile(&second);
    setXY0(&second, 40, 10);
    setWH(&second, 2, 2);
    setRGB0(&second, 0, 248, 0);
    mask(0);
    tile(40, 0, 0, 0);
    mask(3);
    catPrim(&first, &second);
    termPrim(&second);
    DrawOTag((OT_TYPE*)&first);
    expect(40, 0x801f, "same-batch first primitive protects against second");
    mask(0);
    // The STP bit must not be confused with the blending factor in any ABR mode.
    texels = 0x001f8010;
    LoadImage(&source, &texels);
    const unsigned short blended[] = { 0x800c, 0x8018, 0x8000, 0x800c };
    for (int abr = 0; abr < 4; abr++) {
        tile(50, 64, 0, 0);
        SetDrawTPage(&page, 0, 0, GetTPage(2, abr, 64, 0));
        DrawPrim(&page);
        setXY0(&sprite, 50, 10);
        setSemiTrans(&sprite, 1);
        DrawPrim(&sprite);
        expect(50, blended[abr], "semi-transparent color and mask");
        expect(51, 0x001f, "opaque texel in semi-transparent sprite");
    }
    mask(1);
    texels = 0;
    mask(0);
    LoadImage(&source, &texels);
    mask(1);
    tile(50, 0, 248, 0);
    setXY0(&sprite, 50, 10);
    DrawPrim(&sprite);
    expect(50, 0x83e0, "transparent texel preserves existing color and mask");
    DR_ENV fill;
    setlen(&fill, 3);
    fill.code[0] = 0x020000f8;
    fill.code[1] = 10 << 16 | 48;
    fill.code[2] = 1 << 16 | 16;
    mask(3);
    DrawPrim(&fill);
    expect(50, 0x001f, "GPU fill ignores protection and clears mask");
    mask(0);
    check_dithering(0);
    check_dithering(1);
    check_dithering(0);
    check_perspective();
    EM_ASM({ window.tm4GpuMaskResult = { failures : $0 }; }, failures);
    return 0;
}
