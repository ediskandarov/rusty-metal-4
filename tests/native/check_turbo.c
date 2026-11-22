#include "port/extensions/turbo.h"
#include "port/extensions/turbo_runtime.h"
#include "tm4/main/object.h"
#include "tm4/main/registry.h"
#include "tm4/modules/car.h"
#include <assert.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

struct RegistryDirectory {
    int id;
} settings, profile;
struct RegistryFile {
    int type;
    u32 bytes;
    int count;
    void* data;
};
static char path[] = "/test/turbo", class_name[] = "customTurbo";
static SVECTOR mount = { 12, -34, 56, 999 };
static struct RegistryFile ref = { 2, sizeof(path), 1, path };
static struct RegistryFile cls = { 2, sizeof(class_name), 1, class_name };
static struct RegistryFile pos = { 26, sizeof(mount), 1, &mount };
static int present, wrong_kind, mounted, creations, reject, position_directory;
Tm4ObjectList ObjectLists[OBJECT_LIST_COUNT];
static void* owner;
static Rm4TurboAppearanceContext attached;

RegistryDirectory* RegGetDirectoryPtrS(char* name)
{
    if (!strcmp(name, "turboEffect"))
        return present ? &settings : NULL;
    return !strcmp(name, path) ? &profile : NULL;
}
RegistryDirectory* RegGetDirectoryPtrPS(RegistryDirectory* dir, char* name)
{
    assert(dir == &settings && !strcmp(name, "position"));
    return position_directory ? &settings : NULL;
}
RegistryFile* RegGetFilePtrS(char* name)
{
    assert(!strcmp(name, "turboEffect"));
    return wrong_kind ? &ref : NULL;
}
RegistryFile* RegGetFilePtrPS(RegistryDirectory* dir, char* name)
{
    if (dir == &settings) {
        if (!strcmp(name, "profile"))
            return &ref;
        if (!strcmp(name, "position"))
            return mounted ? &pos : NULL;
    }
    if (dir == &profile && !strcmp(name, "class"))
        return &cls;
    return NULL;
}
s32 RegGetFileTypeP(const RegistryFile* f)
{
    return f->type;
}
u32 RegGetFileByteSizeP(const RegistryFile* f)
{
    return f->bytes;
}
s32 RegGetFileArraySizeP(const RegistryFile* f)
{
    return f->count;
}
void* RegGetFileDataP(RegistryFile* f)
{
    return f->data;
}
void* ObjectCreate(char* name, u32 flags, ...)
{
    assert(!strcmp(name, class_name));
    assert(flags == (OBJECT_HAS_OWNER | OBJECT_DESTROY_WITH_OWNER));
    va_list args;
    va_start(args, flags);
    owner = va_arg(args, void*);
    attached = *va_arg(args, Rm4TurboAppearanceContext*);
    va_end(args);
    ++creations;
    return reject ? NULL : &attached;
}
int main(void)
{
    for (int i = 0; i < OBJECT_LIST_COUNT; ++i)
        ObjectLists[i].name = "reserved";
    Car car = { 0 };
    car.character_name = "test";
    assert(WebTurboLoad(&car) && WebTurboAttach(&car) && !creations && !car.turbo_profile);
    wrong_kind = 1;
    assert(!WebTurboLoad(&car));
    wrong_kind = 0;
    present = 1;
    ref.type = 4;
    assert(!WebTurboLoad(&car));
    ref.type = 2;
    ref.bytes = sizeof(path) - 1;
    assert(!WebTurboLoad(&car));
    ref.bytes = sizeof(path);
    path[0] = 'x';
    assert(!WebTurboLoad(&car));
    path[0] = '/';
    position_directory = 1;
    assert(!WebTurboLoad(&car));
    position_directory = 0;
    mounted = 1;
    pos.bytes = 6;
    assert(!WebTurboLoad(&car));
    pos.bytes = sizeof(mount);
    assert(WebTurboLoad(&car) && car.turbo_profile == &profile);
    assert(WebTurboAttach(&car) && owner == &car && creations == 1);
    assert(attached.profile == &profile && attached.position.vx == 12 && attached.position.vy == -34
        && attached.position.vz == 56 && !attached.position.pad);
    reject = 1;
    assert(!WebTurboAttach(&car));
    cls.data = "reserved";
    cls.bytes = sizeof("reserved");
    assert(!WebTurboAttach(&car) && creations == 2);
    present = mounted = 0;
    assert(WebTurboLoad(&car) && !car.turbo_profile && !car.turbo_position.vx);
    puts("PASS turbo profile validation, ownership and original fallback");
}
