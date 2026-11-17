#include "tournament.h"
#include "net_match.h"
#include "participant.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"
#include "tm4/main/pad.h"
#include "tm4/main/tournament.h"
#include <emscripten.h>
#include <libetc.h>
#include <string.h>

void TournamentAdvanceWorld(Tm4GameInfo* game);

_Static_assert(sizeof(WebTournamentCarry) == 28 * sizeof(s32), "Tournament carry ABI");
static WebMatchResult result;

int WebTournamentActive(void) { return WebNetMatchActive() && WebNetTournament(); }

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
        && state.active_computer_count <= GameInfo.entrant_count - GameInfo.player_car_count
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

WebMatchResult WebTournamentResult(void) { return result; }

void WebTournamentRestoreResult(WebMatchResult value) { result = value; }

int WebTournamentResultValid(WebMatchResult value, u32 tick, u32 slots)
{
    if (!value.reasons)
        return !value.tick && !value.winners;
    return value.tick && value.tick <= tick
        && (((value.reasons == 4 || value.reasons == 16) && value.winners == slots)
            || (value.reasons == 8 && !value.winners));
}

void WebTournamentProcessMode(void)
{
    /* Original timers and presentation run before the authority owns teardown. */
    if (!GameInfo.world_won && !GameInfo.tournament_won && !GameInfo.world_lost)
        GameProcessMode();
}

void WebTournamentCompleteTick(void)
{
    if (result.reasons)
        return;
    if (!GameInfo.tournament_accept_input)
        return;
    if (GameInfo.world_lost) {
        result = (WebMatchResult) { MainFrameCount, 8, 0 };
        return;
    }
    if (GameInfo.world_won || GameInfo.tournament_won)
        for (s32 player = 0; player < GameInfo.player_car_count; ++player)
            if (PadJpad[player].pressed_buttons & PADRdown) {
                result = (WebMatchResult) { MainFrameCount, GameInfo.tournament_won ? 4 : 16,
                    WebNetSlotMask() };
                return;
            }
}

EMSCRIPTEN_KEEPALIVE const WebTournamentCarry* WebTournamentNextStage(void)
{
    static WebTournamentCarry carry;
    if (!WebTournamentActive() || result.reasons != 16)
        return NULL;
    Tm4GameInfo next = GameInfo;
    TournamentAdvanceWorld(&next);
    carry = (WebTournamentCarry) { .world = GameGetWorldNameIndex(next.world_name),
        .progress = next.tournament_progress,
        .games_completed = next.games_completed,
        .shared_lives = next.shared_lives };
    WebParticipantState participants;
    WebParticipantCapture(&participants);
    for (s32 i = 0; i < __builtin_popcount(WebNetSlotMask()); ++i) {
        carry.players[i].lives = next.players[i].lives;
        carry.players[i].wins = next.players[i].wins;
        carry.players[i].losses = next.players[i].losses;
        carry.players[i].eliminated = next.players[i].eliminated;
        carry.players[i].frags = participants.slots[i].frags;
        carry.players[i].deaths = participants.slots[i].deaths;
    }
    return &carry;
}

int WebTournamentCarryValid(const WebTournamentCarry* carry, s32 world)
{
    if (!carry || carry->world != world || world < 0 || world >= GameGetNumberOfWorlds()
        || GameHasWorldUnlockRequirement(GameGetWorldName(world))
        || !strcmp(GameGetWorldName(world), GameGetFirstTournamentWorldName())
        || carry->progress <= 0 || carry->progress >= 4096
        || carry->games_completed < carry->progress || (u32)carry->shared_lives > 1)
        return 0;
    for (s32 i = 0; i < 4; ++i)
        if (carry->players[i].lives < 0 || (u32)carry->players[i].eliminated > 1)
            return 0;
    return 1;
}

void WebTournamentApplyCarry(const WebTournamentCarry* carry)
{
    GameInfo.mode = GAME_MODE_PLAY;
    GameInfo.tournament_progress = carry->progress;
    GameInfo.games_completed = carry->games_completed;
    GameInfo.shared_lives = carry->shared_lives;
    WebParticipantState participants;
    WebParticipantCapture(&participants);
    for (s32 i = 0; i < __builtin_popcount(WebNetSlotMask()); ++i) {
        GameInfo.players[i].lives = carry->players[i].lives;
        GameInfo.players[i].wins = carry->players[i].wins;
        GameInfo.players[i].losses = carry->players[i].losses;
        GameInfo.players[i].eliminated = carry->players[i].eliminated;
        participants.slots[i].frags = carry->players[i].frags;
        participants.slots[i].deaths = carry->players[i].deaths;
    }
    WebParticipantRestore(&participants);
}
