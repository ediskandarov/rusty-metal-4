#include "ffa.h"

#include "net_match.h"
#include "participant.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"
#include "tm4/main/system.h"

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
