#include "participant.h"

#include "net_match.h"
#include "tm4/main/object.h"
#include "tm4/modules/car.h"

#include <limits.h>
#include <string.h>

static WebParticipantState participants;

static int equal(WebParticipantId first, WebParticipantId second)
{
    return first.low == second.low && first.high == second.high;
}

static int present(WebParticipantId id)
{
    return id.low || id.high;
}

WebParticipantId WebParticipantIdentity(s32 slot)
{
    return WebNetSlotOccupied(slot) ? participants.slots[slot].id : (WebParticipantId) { 0 };
}

WebParticipantId WebParticipantObjectIdentity(const void* object)
{
    return object ? ObjectGetHeader(object)->participant : (WebParticipantId) { 0 };
}

void WebParticipantRecordDeath(const Car* victim, WebParticipantId source)
{
    if (!WebNetMatchActive())
        return;
    const WebParticipantId dead = WebParticipantObjectIdentity(victim);
    const WebParticipantId attacker = source;
    if (!present(dead))
        return;
    for (s32 slot = 0; slot < 8; ++slot) {
        WebParticipantResult* result = &participants.slots[slot];
        if (equal(result->id, dead) && result->deaths < INT_MAX)
            ++result->deaths;
        /* Environmental damage and suicide do not award a frag. This is a
         * combat statistic; Deathmatch still owns its original round scoring. */
        if (present(attacker) && !equal(attacker, dead) && equal(result->id, attacker)
            && result->frags < INT_MAX)
            ++result->frags;
    }
}

int WebParticipantStateValid(const WebParticipantState* state, u32 mask)
{
    for (s32 slot = 0; slot < 8; ++slot) {
        const WebParticipantResult* result = &state->slots[slot];
        if (present(result->id) != !!(mask & (1u << slot)) || result->frags < 0
            || result->deaths < 0 || (!(mask & (1u << slot)) && (result->frags || result->deaths)))
            return 0;
        for (s32 previous = 0; previous < slot; ++previous)
            if (present(result->id) && equal(result->id, state->slots[previous].id))
                return 0;
    }
    return 1;
}

int WebParticipantParse(WebParticipantState* state, u32 mask, const char* identities)
{
    memset(state, 0, sizeof(*state));
    if (!identities)
        return 0;
    const char* cursor = identities;
    for (s32 slot = 0; slot < 8; ++slot) {
        if (!(mask & (1u << slot)))
            continue;
        WebParticipantId id = { 0 };
        for (s32 digit = 0; digit < 16; ++digit) {
            const char ch = *cursor++;
            if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')))
                return 0;
            id.high = (id.high << 4) | (id.low >> 28);
            id.low = (id.low << 4) | (ch <= '9' ? ch - '0' : ch - 'a' + 10);
        }
        state->slots[slot].id = id;
        if (mask >> (slot + 1)) {
            if (*cursor++ != '\n')
                return 0;
        } else if (*cursor)
            return 0;
    }
    return WebParticipantStateValid(state, mask);
}

void WebParticipantCapture(WebParticipantState* state)
{
    *state = participants;
}
void WebParticipantRestore(const WebParticipantState* state)
{
    participants = *state;
}
