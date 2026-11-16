#include "match_mode.h"
#include "ffa.h"
#include "tm4/main/game.h"
#include "tournament.h"

WebMatchResult WebMatchCapture(void)
{
    return WebTournamentActive() ? WebTournamentResult() : WebFfaCapture();
}

void WebMatchRestore(WebMatchResult result)
{
    if (WebTournamentActive())
        WebTournamentRestoreResult(result);
    else
        WebFfaRestore(result);
}

void WebMatchProcessMode(void)
{
    if (WebTournamentActive())
        WebTournamentProcessMode();
    else
        GameProcessMode();
}

void WebMatchCompleteTick(void)
{
    if (WebTournamentActive())
        WebTournamentCompleteTick();
    else
        WebFfaCompleteTick();
}

int WebMatchResultValid(
    WebMatchResult result, u32 tick, u32 slots, const struct WebParticipantState* participants)
{
    if (WebTournamentActive())
        return WebTournamentResultValid(result, tick, slots);
    return WebFfaResultValid(result, tick, slots, participants);
}
