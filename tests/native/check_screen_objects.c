#include "port/extensions/screen_objects.c"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>

Tm4ObjectList ObjectLists[OBJECT_LIST_COUNT];
static PsyzRect area = { 0, 0, 320, 240 };
PsyzRect WebWidescreenDrawArea(void)
{
    return area;
}
s32 ObjectFindClassIndex(char* name)
{
    return !strcmp(name, "flash") ? 7 : -1;
}

static struct {
    Tm4ObjectHeader header;
    CVECTOR color;
} flash = { .header = { .class_index = 7, .position = { -32768, 0, -32768 } },
    .color = { 123, 45, 67, 1 } };
static Tm4RenderBuffer frames[2];
static int calls;
static TILE* tiles[2];
static int current;
static void display(const void* object, Rm4ScreenDraw* draw)
{
    assert(object == &flash.color);
    const CVECTOR* color = object;
    TILE* tile = Rm4ScreenAllocate(draw, sizeof(*tile));
    assert(tile);
    tiles[current] = tile;
    setTile(tile);
    setXY0(tile, draw->bounds.x, draw->bounds.y);
    setWH(tile, draw->bounds.w, draw->bounds.h);
    setRGB0(tile, color->r, color->g, color->b);
    addPrim(draw->ordering_table, tile);
    ++calls;
}

int main(void)
{
    ObjectLists[0].first = &flash.header;
    assert(!Rm4ScreenObjectRegister(NULL, display));
    assert(!Rm4ScreenObjectRegister("missing", display));
    assert(!Rm4ScreenObjectRegister("flash", NULL));
    assert(Rm4ScreenObjectRegister("flash", display));
    assert(!Rm4ScreenObjectRegister("flash", display));
    CVECTOR before = flash.color;
    TILE existing;
    setTile(&existing);
    for (current = 0; current < 2; ++current) {
        frames[current].buffer_index = current;
        setaddr(frames[current].ordering_table, 0xffffff);
        addPrim(frames[current].ordering_table, &existing);
        if (current)
            area = (PsyzRect) { -160, -30, 480, 270 };
        WebScreenObjectsDisplay(&frames[current]);
        TILE* tile = tiles[current];
        assert(nextPrim(frames[current].ordering_table) == tile);
        assert(nextPrim(tile) == &existing);
        assert(tile->r0 == 123 && tile->g0 == 45 && tile->b0 == 67);
        assert(tile->x0 == area.sx && tile->y0 == area.sy);
        assert(tile->w == area.ex - area.sx && tile->h == area.ey - area.sy);
    }
    assert(calls == 2 && tiles[0] != tiles[1]);
    assert(tiles[0]->w == 320 && tiles[0]->h == 240);
    assert(!memcmp(&before, &flash.color, sizeof(before)));
    // Custom classes and classes without a screen callback are ignored.
    flash.header.class_index = -1;
    WebScreenObjectsDisplay(&frames[0]);
    flash.header.class_index = 8;
    WebScreenObjectsDisplay(&frames[0]);
    assert(calls == 2);
    flash.header.class_index = 7;
    WebScreenObjectsReset();
    WebScreenObjectsDisplay(&frames[0]);
    assert(calls == 2);
    assert(Rm4ScreenObjectRegister("flash", display));
    current = 0;
    setaddr(frames[0].ordering_table, 0xffffff);
    WebScreenObjectsDisplay(&frames[0]);
    assert(calls == 3);
    // A restored instance is found through the class, without registration per object.
    ObjectLists[0].first = NULL;
    WebScreenObjectsDisplay(&frames[0]);
    assert(calls == 3);
    ObjectLists[0].first = &flash.header;
    setaddr(frames[0].ordering_table, 0xffffff);
    WebScreenObjectsDisplay(&frames[0]);
    assert(calls == 4);
    u32 storage[2];
    Rm4ScreenDraw draw = { .cursor = (u8*)storage, .limit = (u8*)(storage + 2) };
    assert(!Rm4ScreenAllocate(&draw, 0));
    assert(!Rm4ScreenAllocate(&draw, SIZE_MAX));
    assert(Rm4ScreenAllocate(&draw, 1) == storage);
    assert(!Rm4ScreenAllocate(&draw, 5));
    assert(Rm4ScreenAllocate(&draw, 4) == storage + 1);
    assert(!Rm4ScreenAllocate(&draw, 1));
    puts(
        "PASS screen objects: independent visibility, packet ordering, wide bounds, double buffering, reset/restore and budget");
    return 0;
}
