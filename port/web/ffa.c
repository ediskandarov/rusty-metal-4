#include "ffa.h"

#include "net_match.h"
#include "participant.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"
#include "tm4/main/system.h"

static WebFfaResult result;

/* Model selection, timing and failure policy belong here; shared lifecycle code creates the
 * car and retains identity, results, selected model and attribution through each attempt. */
enum { RespawnRetryTicks = 30, RespawnAttempts = 3 };

int WebFfaActive(void)
{
    return WebNetMatchActive() && WebNetFfaRespawnDelay();
}

void WebFfaCarRemoved(int slot)
{
    if (WebFfaActive() && !WebNetDeparting()
        && WebParticipantScheduleRespawn(slot, (u32)MainFrameCount + WebNetFfaRespawnDelay(),
            RespawnRetryTicks, RespawnAttempts)) {
        /* Consume gameplay RNG only once, after successful scheduling at removal.
         * Rejection sampling avoids modulo bias in the game's 15-bit rand().
         * The canonical pool index survives waiting, retries and recovery. */
        const u32 count = WebNetModelCount(), limit = 32768u - 32768u % count;
        u32 choice;
        do {
            choice = rand();
        } while (choice >= limit);
        WebParticipantSelectRespawnModel(slot, choice % count + 1);
    }
    /* Exhaustion remains terminal waiting until explicit leave or teardown. */
}

WebFfaResult WebFfaCapture(void)
{
    return result;
}

void WebFfaRestore(WebFfaResult value)
{
    result = value;
}

int WebFfaResultValid(WebFfaResult value, u32 tick, u32 slots,
    const WebParticipantState* participants)
{
    if (!WebFfaActive())
        return !value.tick && !value.reasons && !value.winners;
    u32 winners = 0;
    s32 best = (-2147483647 - 1);
    for (s32 slot = 0; slot < 8; ++slot) {
        if (!(slots & (1u << slot)))
            continue;
        const s32 frags = participants->slots[slot].frags;
        if (frags > best) {
            best = frags;
            winners = 0;
        }
        if (frags == best)
            winners |= 1u << slot;
    }
    const u32 end = value.reasons ? value.tick : tick;
    const u32 reasons = (end >= WebNetFfaTimeLimit() ? 1u : 0u)
        | (best >= (s32)WebNetFfaFragLimit() ? 2u : 0u);
    if (!value.reasons)
        return !value.tick && !value.winners && !reasons;
    return value.tick && value.tick <= tick && value.reasons == reasons && value.winners == winners;
}

void WebFfaCompleteTick(void)
{
    if (!WebFfaActive() || result.reasons)
        return;
    WebParticipantState participants;
    WebParticipantCapture(&participants);
    u32 reasons = (u32)MainFrameCount >= WebNetFfaTimeLimit() ? 1 : 0;
    u32 winners = 0;
    s32 best = (-2147483647 - 1);
    for (s32 slot = 0; slot < WebNetSlotCapacity(); ++slot) {
        if (!WebNetSlotOccupied(slot))
            continue;
        const s32 frags = participants.slots[slot].frags;
        if (frags >= (s32)WebNetFfaFragLimit())
            reasons |= 2;
        if (frags > best) {
            best = frags;
            winners = 0;
        }
        if (frags == best)
            winners |= 1u << slot;
    }
    if (!reasons)
        return;
    /* Evaluate only after all deaths/scoring in the tick. A simultaneous threshold
     * records both causes; all highest scores tie, with no death-count tiebreak. */
    result = (WebFfaResult) { MainFrameCount, reasons, winners };
    GameInfo.deathmatch_finished = 1;
    for (s32 slot = 0; slot < WebNetSlotCapacity(); ++slot)
        if (participants.respawns[slot].state == WebCarScheduled)
            participants.respawns[slot] = (WebParticipantRespawn) { .state = WebCarWaiting };
    WebParticipantRestore(&participants);
}
