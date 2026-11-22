/* Exercise the actual class/pair registry, including allocation failures. */
#define TM4_OBJECT_FUNCTION 0x80018154
#include "src/main/object/classes.c"
#undef TM4_OBJECT_FUNCTION
#define TM4_OBJECT_FUNCTION 0x800181c0
#include "src/main/object/classes.c"
#undef TM4_OBJECT_FUNCTION
#define TM4_OBJECT_FUNCTION 0x8001823c
#include "src/main/object/classes.c"
#undef TM4_OBJECT_FUNCTION
#define TM4_OBJECT_FUNCTION 0x80018428
#include "src/main/object/classes.c"
#undef TM4_OBJECT_FUNCTION
#define TM4_OBJECT_FUNCTION 0x80019e68
#include "src/main/object/classes.c"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

Tm4ObjectClass* ObjectClasses;
s32 ObjectClassCount;
Tm4ObjectPair* ObjectInteractionPairs;
Tm4ObjectList ObjectLists[OBJECT_LIST_COUNT];
Tm4WorldSquare* ObjectActiveInteractionCells;
u32 ObjectNextSerial;
static unsigned allocations, fail_at, bindings, destroyed, reset;
void* MemAlloc(u32 size)
{
    return ++allocations == fail_at ? NULL : malloc(size);
}
void* MemRealloc(void* old, u32 size)
{
    /* Fail every subsequent resize too, including a misguided cleanup shrink. */
    return ++allocations >= fail_at && fail_at ? NULL : realloc(old, size);
}
void MemFree(void* memory)
{
    free(memory);
}
void WebSnapshotRegisterClass(s32 index, const char* name, size_t size)
{
    ++bindings;
}
void WebSnapshotResetClasses(void)
{
    bindings = 0;
    ++reset;
}
void ObjectDestroyList(Tm4ObjectHeader** first)
{
    assert(ObjectClasses && ObjectInteractionPairs && !reset);
    *first = NULL;
    ++destroyed;
}
s32 ObjectDestructDirectoryClass(char* name, RegistryDirectory* directory)
{
    return 0;
}
s32 ObjectDirectoryRecurse(Tm4DirectoryVisitor visitor)
{
    assert(visitor == ObjectDestructDirectoryClass && destroyed == OBJECT_LIST_COUNT);
    assert(ObjectClasses && ObjectInteractionPairs && !reset);
    return 1;
}
static void interact(void* first, void* second)
{
}
static int add(char* name)
{
    return ObjectRegisterClass(name, 4, NULL, NULL, NULL, NULL, NULL, NULL);
}
int main(void)
{
    for (int failed_step = 1; failed_step <= 3; ++failed_step) {
        allocations = fail_at = destroyed = reset = 0;
        assert(add("first"));
        assert(ObjectRegisterInteractionCallback("first", "first", interact));
        fail_at = allocations + failed_step;
        assert(!add("second"));
        assert(ObjectClassCount == 1 && bindings == 1);
        assert(ObjectFindClassIndex("first") == 0 && ObjectFindClassIndex("second") == -1);
        assert(ObjectFindInteractionCallback("first", "first") == interact);
        fail_at = 0;
        assert(add("second"));
        assert(!add("second"));
        assert(!ObjectRegisterInteractionCallback("missing", "first", interact));
        assert(ObjectRegisterInteractionCallback("second", "first", interact));
        assert(!ObjectRegisterInteractionCallback("first", "second", interact));
        assert(ObjectInteractionPairs[1].reversed == 1);
        assert(ObjectFindInteractionCallback("first", "second") == interact);
        ObjectDestructor();
        assert(!ObjectClassCount && !ObjectClasses && !ObjectInteractionPairs && !bindings);
        assert(reset == 1);
    }
    puts("PASS class registration failures, interactions and teardown");
}
