#include "ffa.h"

#include "net_match.h"
#include "participant.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"

/* Only timing and failure policy belong here; shared lifecycle code creates the
 * car and retains identity, results, model and attribution through each attempt. */
enum { RespawnRetryTicks = 30, RespawnAttempts = 3 };

int WebFfaActive(void)
{
    return WebNetMatchActive() && WebNetFfaRespawnDelay();
}

void WebFfaCarRemoved(int slot)
{
    if (WebFfaActive())
        WebParticipantScheduleRespawn(slot, (u32)MainFrameCount + WebNetFfaRespawnDelay(),
            RespawnRetryTicks, RespawnAttempts);
    /* Exhaustion remains terminal waiting until explicit leave or teardown. */
}
