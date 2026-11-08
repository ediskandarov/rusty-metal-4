#include <assert.h>
#include <libgpu.h>
#include <stdio.h>
#include <string.h>

int __wrap_Draw_PushPrim(u_long*, int);
static u_long emitted[2][16];
static int lengths[2], calls;
static u_long* passed_pointer;

int __real_Draw_PushPrim(u_long* packets, int length)
{
    assert(calls < 2 && length <= 16);
    passed_pointer = packets;
    lengths[calls] = length;
    memcpy(emitted[calls++], packets, length * sizeof(*packets));
    return length;
}

static u_long xy(int x, int y)
{
    return (u_short)x | (u_long)(u_short)y << 16;
}

static void reset(void)
{
    calls = 0;
    memset(emitted, 0, sizeof(emitted));
}

static int packet(unsigned int code, const u_long* positions, u_long* output)
{
    int length = 0, count = code & 8 ? 4 : 3;
    for (int i = 0; i < count; ++i) {
        if (i == 0 || (code & 16))
            output[length++] = (i == 0 ? code << 24 : 0) | (0x123456 + i);
        output[length++] = positions[i];
        if (code & 4)
            output[length++] = (i == 0          ? 0x43210000
                                       : i == 1 ? 0x01230000
                                                : 0)
                | (0x1517 + i * 0x101);
    }
    return length;
}

static void check_triangle(unsigned int code, int half, const u_long* positions, int rejected)
{
    const int vertices[2][3] = { { 0, 1, 2 }, { 1, 3, 2 } };
    int word = 0;
    for (int i = 0; i < 3; ++i) {
        int vertex = vertices[half][i];
        if (i == 0 || (code & 16)) {
            int color_vertex = code & 16 ? vertex : 0;
            u_long expected = (i == 0 ? (code & ~8u) << 24 : 0) | (0x123456 + color_vertex);
            assert(emitted[half][word++] == expected);
        }
        assert(emitted[half][word++] == positions[rejected ? vertices[half][0] : vertex]);
        if (code & 4) {
            u_long expected = (i == 0          ? 0x43210000
                                      : i == 1 ? 0x01230000
                                               : 0)
                | (0x1517 + vertex * 0x101);
            assert(emitted[half][word++] == expected);
        }
    }
    assert(word == lengths[half]);
}

int main(void)
{
    /* Coordinates from a crane command that used to fill most of the viewport. */
    u_long crane[] = { 0x3c808080, 0x01ff000f, 0x00000000, 0x00808080, 0xfc60ff6e, 0x00000000,
        0x00808080, 0x03bcff7f, 0x00000000, 0x00808080, 0xfce6ff6e, 0x00000000 };
    reset();
    assert(__wrap_Draw_PushPrim(crane, 12) == 12);
    assert(calls == 2);
    for (int i = 0; i < 2; ++i)
        assert(emitted[i][1] == emitted[i][4] && emitted[i][4] == emitted[i][7]);

    for (unsigned int code = 0x20; code <= 0x3f; ++code) {
        u_long input[16], saved[16];
        u_long positions[] = { xy(-512, -255), xy(511, -255), xy(-512, 256), xy(511, 256) };
        int length = packet(code, positions, input);
        memcpy(saved, input, length * sizeof(*input));
        reset();
        assert(__wrap_Draw_PushPrim(input, length) == length);
        assert(calls == 1 && passed_pointer == input); /* Exact maximum dimensions. */
        assert(!memcmp(emitted[0], input, length * sizeof(*input)));

        /* Signed 11-bit coordinates ignore the upper five bits of each halfword. */
        int stride = 1 + !!(code & 4) + !!(code & 16);
        for (int i = 0; i < (code & 8 ? 4 : 3); ++i)
            input[1 + i * stride] ^= 0xf800f800;
        reset();
        __wrap_Draw_PushPrim(input, length);
        assert(calls == 1 && passed_pointer == input);

        for (int axis = 0; axis < 2; ++axis) {
            /* First half too wide/tall, second half valid. */
            positions[0] = axis ? xy(0, -512) : xy(-1024, 0);
            positions[1] = xy(0, 0);
            positions[2] = xy(100, 0);
            positions[3] = xy(100, 100);
            length = packet(code, positions, input);
            memcpy(saved, input, length * sizeof(*input));
            reset();
            assert(__wrap_Draw_PushPrim(input, length) == length);
            assert(calls == (code & 8 ? 2 : 1));
            check_triangle(code, 0, positions, 1);
            if (code & 8)
                check_triangle(code, 1, positions, 0);
            assert(!memcmp(saved, input, length * sizeof(*input)));
        }
        if (code & 8) {
            /* Only the second half is oversized. */
            positions[0] = xy(0, 100);
            positions[3] = xy(0, -512);
            length = packet(code, positions, input);
            reset();
            assert(__wrap_Draw_PushPrim(input, length) == length);
            check_triangle(code, 0, positions, 0);
            check_triangle(code, 1, positions, 1);
        }
    }
    u_long tile[] = { 0x60000000, 0, 0x03ff03ff };
    reset();
    assert(__wrap_Draw_PushPrim(tile, 3) == 3);
    assert(calls == 1 && passed_pointer == tile);
    puts(
        "PASS GPU polygon limits, independent quad halves, all 32 polygon opcodes, attributes and source preservation");
}
