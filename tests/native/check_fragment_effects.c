#include "port/extensions/fragment_effects_runtime.h"
#include "tm4/main/os.h"
#include "tm4/main/registry.h"
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static jmp_buf rejected;
static _Noreturn void reject(void)
{
    longjmp(rejected, 1);
}
#define abort reject
#include "port/extensions/fragment_effects.c"
#undef abort

static int present, type = REG_FILE_TYPE_STRING, missing_symbol, lookups, calls;
static char symbol[] = "testFragmentEffects";
static u32 bytes = sizeof(symbol);
static Rm4FragmentImpact received;
static void impact(const Rm4FragmentImpact* event)
{
    received = *event;
    ++calls;
}
static Rm4FragmentEffects provider = {
    .version = RM4_FRAGMENT_EFFECTS_VERSION,
    .size = sizeof(Rm4FragmentEffects),
    .impact = impact,
};
RegistryFile* RegGetFilePtrS(char* path)
{
    assert(!strcmp(path, "/world/fragmentEffects"));
    return present ? (RegistryFile*)1 : NULL;
}
s32 RegGetFileTypeP(const RegistryFile* file)
{
    return type;
}
u32 RegGetFileByteSizeP(const RegistryFile* file)
{
    return bytes;
}
void* RegGetFileDataP(RegistryFile* file)
{
    return symbol;
}
OSWord OSSymbolGetAddress(char* name)
{
    ++lookups;
    assert(!strcmp(name, "testFragmentEffects"));
    return missing_symbol ? 0 : (OSWord)&provider;
}
static SVECTOR position = { 12, -34, 56, 123 };
static void invalid(void)
{
    if (!setjmp(rejected)) {
        WebFragmentEffectsLoad();
        assert(!"Invalid provider accepted");
    }
    assert(!WebFragmentEffectsImpact(&position, 32, 7, 2));
}
int main(void)
{
    WebFragmentEffectsLoad();
    assert(!WebFragmentEffectsImpact(&position, 32, 7, 2));
    present = 1;
    WebFragmentEffectsLoad();
    assert(lookups == 1);
    for (int i = 0; i < 3; ++i)
        assert(WebFragmentEffectsImpact(&position, 32, 7, 2));
    assert(lookups == 1 && calls == 3);
    assert(received.position.vx == 12 && received.position.vy == -34 && received.position.vz == 56);
    assert(!received.position.pad && received.effect_size == 32 && received.material == 7
        && received.surface_kind == 2);
    WebFragmentEffectsUnload();
    assert(!WebFragmentEffectsImpact(&position, 32, 7, 2));
    type = REG_FILE_TYPE_BINARY;
    invalid();
    type = REG_FILE_TYPE_STRING;
    bytes = 0;
    invalid();
    bytes = sizeof(symbol) - 1;
    invalid();
    bytes = sizeof(symbol);
    symbol[0] = 0;
    invalid();
    symbol[0] = 't';
    missing_symbol = 1;
    invalid();
    missing_symbol = 0;
    ++provider.version;
    invalid();
    --provider.version;
    --provider.size;
    invalid();
    ++provider.size;
    provider.impact = NULL;
    invalid();
    provider.impact = impact;
    WebFragmentEffectsLoad();
    assert(WebFragmentEffectsImpact(&position, 64, 1, 8));
    present = 0;
    WebFragmentEffectsLoad();
    assert(!WebFragmentEffectsImpact(&position, 32, 7, 2));
    puts("PASS fragment provider validation, events, unload and reload");
}
