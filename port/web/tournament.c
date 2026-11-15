#include "tournament.h"
#include "net_match.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"

static WebMatchResult result;

int WebTournamentActive(void)
{
    return WebNetMatchActive() && WebNetTournament();
}

WebTournamentState WebTournamentCapture(void)
{
    WebTournamentState state = { 0 };
    if (WebTournamentActive()) {
#define FIELD(name) state.name = GameInfo.name;
        WEB_TOURNAMENT_FIELDS(FIELD)
#undef FIELD
    }

    return state;
}

int WebTournamentStateValid(WebTournamentState state)
{
    if (!WebTournamentActive()) {
#define FIELD(name)                                                                                \
    if (state.name)                                                                                \
        return 0;
        WEB_TOURNAMENT_FIELDS(FIELD)
#undef FIELD
        return 1;
    }

    return (u32)state.active <= 1 && (u32)state.shared_lives <= 1 && (u32)state.world_won <= 1
        && (u32)state.world_lost <= 1 && (u32)state.tournament_won <= 1
        && (u32)state.reinforcements_spawned <= 1 && (u32)state.bosses_spawned <= 1
        && (u32)state.bosses_active <= 1 && state.active_computer_count >= 0
        && state.active_computer_count <= GameInfo.entrant_count - 2
        && state.initial_computer_count == GameInfo.initial_computer_count
        && state.reinforcement_threshold == GameInfo.reinforcement_threshold
        && state.boss_count == GameInfo.boss_count && !state.resume_tournament && !state.save_menu;
}

void WebTournamentRestore(WebTournamentState state)
{
    if (!WebTournamentActive())
        return;
#define FIELD(name) GameInfo.name = state.name;
    WEB_TOURNAMENT_FIELDS(FIELD)
#undef FIELD
}

WebMatchResult WebTournamentResult(void)
{
    return result;
}

void WebTournamentRestoreResult(WebMatchResult value)
{
    result = value;
}

int WebTournamentResultValid(WebMatchResult value, u32 tick, u32 slots)
{
    if (!value.reasons)
        return !value.tick && !value.winners;
    return value.tick && value.tick <= tick
        && ((value.reasons == 4 && value.winners == slots)
            || (value.reasons == 8 && !value.winners));
}

void WebTournamentCompleteTick(void)
{
    if (result.reasons)
        return;
    /* Original TournamentProcess decides the outcome. Stop at that boundary before
     * its offline menu/world transition; campaign continuation belongs to the server. */
    if (GameInfo.world_won || GameInfo.tournament_won)
        result = (WebMatchResult) { MainFrameCount, 4, WebNetSlotMask() };
    else if (GameInfo.world_lost)
        result = (WebMatchResult) { MainFrameCount, 8, 0 };
}

