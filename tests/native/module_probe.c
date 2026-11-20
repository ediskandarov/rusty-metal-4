#include <stdint.h>
static int probe(void)
{
    return 37;
}
uintptr_t Tm4ModuleExport(const char* name)
{
    const char* expected = "ProbeValue";
    while (*name && *name == *expected) {
        name++;
        expected++;
    }
    return !*name && !*expected ? (uintptr_t)probe : 0;
}
