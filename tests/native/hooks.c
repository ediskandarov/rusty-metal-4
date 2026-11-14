#include "hooks.h"
#include "hooks/pending.h"

/* Browser commands may arrive during an Asyncify yield; mutate objects at a tick boundary. */
void WebTestApplyPendingActions(void)
{
    WebTestApplyHudMessages();
    WebTestApplyAudioActions();
    WebTestApplyParticipantActions();
    WebTestApplySceneryActions();
    WebTestApplyCoopActions();
    WebTestApplyHelicopterShot();
    WebTestApplyMatchActions();
}
