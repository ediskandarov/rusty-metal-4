#include <libgte.h>
#include <libgpu.h>
#include "subpixel.h"
#ifdef TM4_WEB_SUBPIXEL
#include "../web/subpixel.h"
#endif

/* PsyZ declares this PsyQ command builder but does not implement it yet. */
void SetDrawStp(DR_STP* packet, int enabled)
{
    setlen(packet, 2);
    packet->code[0] = 0xe6000000 | (enabled ? 1 : 0);
    packet->code[1] = 0;
}

int __real_Draw_PushPrim(u_long* packets, int max_len);

static int coordinate11(u_long coordinate)
{
    return (int)((coordinate & 0x7ff) ^ 0x400) - 0x400;
}

static int oversized_triangle(const u_long* packets, const int* xy, const int* vertices)
{
    int min_x = 1023, min_y = 1023, max_x = -1024, max_y = -1024;
    for (int i = 0; i < 3; ++i) {
        u_long position = packets[xy[vertices[i]]];
        int x = coordinate11(position), y = coordinate11(position >> 16);
        if (x < min_x)
            min_x = x;
        if (x > max_x)
            max_x = x;
        if (y < min_y)
            min_y = y;
        if (y > max_y)
            max_y = y;
    }
    return max_x - min_x >= 1024 || max_y - min_y >= 512;
}

static int submit_polygon(u_long* packets, int max_len, const PsyzSubpixelPosition* positions,
    unsigned int options)
{
#ifdef TM4_WEB_SUBPIXEL
    if (positions != NULL) {
        unsigned int code = packets[0] >> 24;
        int count = code & 8 ? 4 : 3;
        if (options & PSYZ_STABILIZE_VERTICES)
            WebSubpixelRecordSubmission(packets, positions, count);
        return Psyz_DrawPushPrimWithPositions(packets, max_len, positions, options);
    }
#else
    (void)positions;
    (void)options;
#endif
    return __real_Draw_PushPrim(packets, max_len);
}

static void draw_triangle(const u_long* packets, const int* xy, const int* vertices, int rejected,
    const PsyzSubpixelPosition* positions, unsigned int options)
{
    unsigned int code = (packets[0] >> 24) & ~8u;
    int textured = (code & 4) != 0, gouraud = (code & 16) != 0;
    u_long triangle[9];
    int length = 0;
    PsyzSubpixelPosition triangle_positions[3];
    for (int i = 0; i < 3; ++i) {
        int vertex = vertices[i];
        if (positions != NULL && !rejected)
            triangle_positions[i] = positions[vertex];
        if (gouraud || i == 0) {
            u_long color = packets[gouraud ? xy[vertex] - 1 : 0] & 0xffffff;
            triangle[length++] = color | (i == 0 ? code << 24 : 0);
        }
        /* A rejected triangle still passes its texture state to the backend, but
         * coincident vertices produce no fragments. Never alter the source OT. */
        triangle[length++] = packets[xy[rejected ? vertices[0] : vertex]];
        if (textured) {
            u_long uv = packets[xy[vertex] + 1] & 0xffff;
            /* CLUT and TPage belong to the polygon, not the selected vertex. */
            if (i < 2)
                uv |= packets[xy[i] + 1] & 0xffff0000;
            triangle[length++] = uv;
        }
    }
    submit_polygon(
        triangle, length, positions != NULL && !rejected ? triangle_positions : NULL, options);
}

/* PS1 rejects triangles spanning >=1024 pixels horizontally or >=512 vertically.
 * PsyZ's GL backend clips these instead, stretching near-camera geometry across
 * the screen. Quads are two independent triangles; retain either valid half.
 * https://psx-spx.consoledev.net/graphicsprocessingunitgpu/#vertex-parameter-for-polygon-line-rectangle-commands
 */
int __wrap_Draw_PushPrim(u_long* packets, int max_len)
{
    if (max_len <= 0)
        return __real_Draw_PushPrim(packets, max_len);
    unsigned int code = packets[0] >> 24;
    if ((code & 0xe0) != 0x20)
        return __real_Draw_PushPrim(packets, max_len);
    int textured = (code & 4) != 0, quad = (code & 8) != 0, gouraud = (code & 16) != 0;
    int count = quad ? 4 : 3;
    int stride = 1 + textured + gouraud;
    int length = 1 + count * (1 + textured) + (count - 1) * gouraud;
    if (max_len < length)
        return __real_Draw_PushPrim(packets, max_len);
    const PsyzSubpixelPosition* positions = NULL;
    unsigned int options = 0;
#ifdef TM4_WEB_SUBPIXEL
    positions = WebSubpixelFindPacket(packets, count, &options);
#endif
    int xy[4] = { 1, 1 + stride, 1 + stride * 2, 1 + stride * 3 };
    const int first[3] = { 0, 1, 2 }, second[3] = { 1, 3, 2 };
    int reject_first = oversized_triangle(packets, xy, first);
    int reject_second = quad && oversized_triangle(packets, xy, second);
    if (!reject_first && !reject_second)
        return submit_polygon(packets, max_len, positions, options);
    draw_triangle(packets, xy, first, reject_first, positions, options);
    if (quad)
        draw_triangle(packets, xy, second, reject_second, positions, options);
    return length;
}
