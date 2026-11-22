#ifndef RM4_SCREEN_OBJECTS_H
#define RM4_SCREEN_OBJECTS_H

#include "tm4/gpu.h"
#include <libgpu.h>
#include <stddef.h>

typedef struct {
    Tm4OrderingTag* ordering_table;
    /* Entire output, including widescreen margins; shared by split-screen views. */
    RECT bounds;
    u8* cursor;
    u8* limit;
} Rm4ScreenDraw;

/* Register after ObjectRegisterClass, during level class construction. One screen
 * callback per class. Ordinary world display may be NULL. Registration lasts until
 * ObjectDestructor. Failure (unknown class, NULL or duplicate callback) returns 0.
 * Draw runs once per built frame, in object-list order, independently of visibility.
 * It must not modify simulation state, RNG, object lists or retain draw pointers.
 * Packets are layered over the scene/HUD and below global messages/view borders.
 * An object needing per-player masking must clip its own primitives. */
typedef void (*Rm4ScreenDisplay)(const void* object, Rm4ScreenDraw* draw);
int Rm4ScreenObjectRegister(char* class_name, Rm4ScreenDisplay display);

/* Frame-local, word-aligned packet storage; NULL on budget exhaustion. Allocate
 * all required packets before linking any of them. Never retain this storage in
 * an object or snapshot. The shared budget is 4 KiB per frame, double buffered. */
void* Rm4ScreenAllocate(Rm4ScreenDraw* draw, size_t bytes);

#endif
