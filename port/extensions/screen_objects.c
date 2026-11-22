#include "port/web/widescreen.h"
#include "screen_objects_runtime.h"
#include "tm4/main/object.h"
#include <limits.h>
#include <string.h>

/* Object headers store a signed byte class index. Custom classes use -1. */
static Rm4ScreenDisplay displays[SCHAR_MAX + 1];
static u32 packets[2][1024];
static int registered;

int Rm4ScreenObjectRegister(char* class_name, Rm4ScreenDisplay display)
{
    if (!class_name || !display)
        return 0;
    int index = ObjectFindClassIndex(class_name);
    if (index < 0 || index > SCHAR_MAX || displays[index])
        return 0;
    displays[index] = display;
    registered = 1;
    return 1;
}

void WebScreenObjectsReset(void)
{
    memset(displays, 0, sizeof(displays));
    registered = 0;
}

void* Rm4ScreenAllocate(Rm4ScreenDraw* draw, size_t bytes)
{
    size_t available = draw->limit - draw->cursor;
    if (!bytes || bytes > available)
        return NULL;
    size_t aligned = (bytes + 3) & ~(size_t)3;
    if (aligned > available)
        return NULL;
    void* result = draw->cursor;
    draw->cursor += aligned;
    return result;
}

void WebScreenObjectsDisplay(Tm4RenderBuffer* buffer)
{
    if (!registered || buffer->buffer_index < 0 || buffer->buffer_index >= 2)
        return;
    PsyzRect area = WebWidescreenDrawArea();
    u8* start = (u8*)packets[buffer->buffer_index];
    Rm4ScreenDraw draw = {
        .ordering_table = buffer->ordering_table,
        .bounds = { area.sx, area.sy, area.ex - area.sx, area.ey - area.sy },
        .cursor = start,
        .limit = start + sizeof(packets[0]),
    };
    for (int list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* object = ObjectLists[list].first; object; object = object->next) {
            int index = object->class_index;
            if (index >= 0 && displays[index])
                displays[index](ObjectGetPayload(object), &draw);
        }
    }
}
