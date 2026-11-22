/* Exercise the real registry storage path, including both decompression branches. */
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
static jmp_buf rejected;
static int expect_rejection;
static void reject_archive(void) __attribute__((noreturn));
static void reject_archive(void)
{
    assert(expect_rejection);
    longjmp(rejected, 1);
}
#define abort reject_archive
#define TM4_REGISTRY_FUNCTION 0x80011808
#include "src/main/registry.c"
#undef abort
static void* allocations[8];
static unsigned allocation_count;
void* MemAlloc(u32 size)
{
    assert(allocation_count < 8);
    void* data = malloc(size);
    assert(data);
    allocations[allocation_count++] = data;
    return data;
}
void* MemAllocTail(u32 size)
{
    return MemAlloc(size);
}
void MemFree(void* data)
{
    for (unsigned i = 0; i < allocation_count; ++i)
        if (allocations[i] == data) {
            free(data);
            allocations[i] = NULL;
            return;
        }
    assert(!"unknown allocation");
}
void MemCopy(void* to, const void* from, u32 size)
{
    memcpy(to, from, size);
}
s32 RegistryBuildDirectoryPath(RegistryDirectory* root, RegistryDirectory* dir, char* path)
{
    path[0] = 0;
    return 1;
}
char* RegistryGetRegistrationName(s32 registration)
{
    return "fixture";
}
s32 RegistryDeleteFile(RegistryDirectory* dir, RegistryFile* file, s32 registration)
{
    assert(!"test creates only new files");
    return 0;
}
static unsigned handler_calls;
static s32 handler(char* path, s32 type, s32 size, void* data, char* registration)
{
    assert(size == 7 && !memcmp(data, "pixels", 7));
    ++handler_calls;
    return 0;
}
static void clear(void)
{
    for (unsigned i = 0; i < allocation_count; ++i)
        free(allocations[i]);
    allocation_count = 0;
}
static void check(void* payload, unsigned stored, unsigned expanded, int invalid)
{
    RegistryDirectory directory = { 0 };
    unsigned before = handler_calls;
    expect_rejection = invalid;
    if (!setjmp(rejected)) {
        assert(
            RegistryDispatchOrStoreFile(&directory, "pixels", 3, -1, stored, expanded, payload, 0));
        assert(!invalid);
        assert(RegGetFileByteSizeP(directory.files) == 7);
        const void* data = (u8*)directory.files + offsetof(RegistryFile, name) + 8;
        assert(!memcmp(data, "pixels", 7));
    } else {
        assert(invalid && !directory.files && handler_calls == before);
    }
    clear();
}
int main(void)
{
    unsigned char compressed[64];
    unsigned long size = sizeof(compressed);
    assert(compress(compressed, &size, (const unsigned char*)"pixels", 7) == Z_OK);
    assert(RegGetFileByteSizeP(NULL) == 0);
    for (unsigned handled = 0; handled < 2; ++handled) {
        RegistryTypeHandlers[3] = handled ? handler : NULL;
        check("pixels", 7, 0, 0);
        check(compressed, size, 7, 0);
        check(compressed, size, 8, 1);
        check(compressed, size, 6, 1);
        check(compressed, size - 1, 7, 1);
    }
    puts("PASS registry byte lengths and rejection of truncated or mis-sized compressed payloads");
    return 0;
}
