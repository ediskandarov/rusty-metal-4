#include "cheats.h"
#include "net_match.h"
#include "tm4/main/easteregg.h"
#include <emscripten.h>

void EasterEggMakeAccessible(s32 index);

/* Original EasterEggEntries indices exposed by the browser menu. */
static const s32 cheat_indices[] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 21 };
static u32 pending_changes;
static u32 pending_enabled;

EMSCRIPTEN_KEEPALIVE int WebSetCheat(s32 index, int enabled)
{
    if (WebNetMatchActive())
        return 0;
    for (unsigned int i = 0; i < sizeof(cheat_indices) / sizeof(*cheat_indices); ++i) {
        if (cheat_indices[i] != index)
            continue;
        u32 bit = 1u << index;
        pending_changes |= bit;
        if (enabled)
            pending_enabled |= bit;
        else
            pending_enabled &= ~bit;
        return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE u32 WebGetCheats(void)
{
    u32 flags = 0;
    for (unsigned int i = 0; i < sizeof(cheat_indices) / sizeof(*cheat_indices); ++i) {
        s32 index = cheat_indices[i];
        if (EasterEggAccessible(index))
            flags |= 1u << index;
    }
    return (flags & ~pending_changes) | (pending_enabled & pending_changes);
}

/* Apply between frames, never in a suspended constructor or input callback. */
void WebApplyCheats(void)
{
    if (WebNetMatchActive() || !pending_changes)
        return;
    for (unsigned int i = 0; i < sizeof(cheat_indices) / sizeof(*cheat_indices); ++i) {
        s32 index = cheat_indices[i];
        u32 bit = 1u << index;
        if (!(pending_changes & bit))
            continue;
        if (pending_enabled & bit)
            EasterEggMakeAccessible(index);
        else
            EasterEggMakeInaccessible(index);
    }
    pending_changes = 0;
}

void WebResetNetworkCheats(void)
{
    pending_changes = pending_enabled = 0;
    for (unsigned i = 0; i < sizeof(cheat_indices) / sizeof(*cheat_indices); ++i)
        EasterEggMakeInaccessible(cheat_indices[i]);
}
