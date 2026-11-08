#include "tm4/gte.h"
#include <assert.h>
#include <emscripten.h>
#include <stdlib.h>

int main(void)
{
    InitGeom();
    SetGeomOffset(160, 120);
    SetGeomScreen(256);
    const MATRIX matrix = { .m = { { 4096, 0, 0 }, { 0, 4096, 0 }, { 0, 0, 4096 } } };
    MATRIX transform = matrix;
    SetRotMatrix(&transform);
    SetTransMatrix(&transform);
    for (int count = 1; count <= 8; ++count) {
        SVECTOR* vertices = malloc(count * sizeof(*vertices));
        assert(vertices);
        for (int i = 0; i < count; ++i)
            vertices[i] = (SVECTOR) { .vx = i * 37 - 80, .vy = 90 - i * 23, .vz = 500 + i * 100 };
        for (int first = 0; first < count; first += 3) {
            int remaining = count - first;
            int used = remaining < 3 ? remaining : 3;
            SVECTOR padded[3] = {
                { .vx = 30000, .vy = -30000, .vz = 1 },
                { .vx = -30000, .vy = 30000, .vz = -1 },
                { .vx = 0, .vy = 0, .vz = 0 },
            };
            unsigned expected_xy[3], expected_z[3];
            for (int i = 0; i < used; ++i)
                padded[i] = vertices[first + i];
            gte_ldv3c(padded);
            gte_rtpt();
            for (int i = 0; i < used; ++i) {
                expected_xy[i] = Psyz_GteDataRead(12 + i);
                expected_z[i] = Psyz_GteDataRead(17 + i);
            }
            WebGteLoadVertexBatch(vertices + first, remaining);
            gte_rtpt();
            for (int i = 0; i < used; ++i) {
                assert(Psyz_GteDataRead(12 + i) == expected_xy[i]);
                assert(Psyz_GteDataRead(17 + i) == expected_z[i]);
            }
        }
        free(vertices);
    }
    EM_ASM({ globalThis.tm4GteBatchesPassed = true; });
    return 0;
}
