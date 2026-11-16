#ifndef TM4_WEB_TOURNAMENT_H
#define TM4_WEB_TOURNAMENT_H
#include "match_mode.h"
#define WEB_TOURNAMENT_FIELDS(X)                                                                   \
    X(active)                                                                                      \
    X(active_computer_count)                                                                       \
    X(shared_lives)                                                                                \
    X(resume_tournament)                                                                           \
    X(tournament_won)                                                                              \
    X(world_won)                                                                                   \
    X(world_lost)                                                                                  \
    X(initial_computer_count)                                                                      \
    X(reinforcement_threshold)                                                                     \
    X(reinforcements_spawned)                                                                      \
    X(boss_count)                                                                                  \
    X(bosses_spawned)                                                                              \
    X(bosses_active)                                                                               \
    X(tournament_progress)                                                                         \
    X(tournament_next_mode)                                                                        \
    X(tournament_accept_input)                                                                     \
    X(save_menu)
#define FIELD(name) s32 name;
typedef struct WebTournamentState {
    WEB_TOURNAMENT_FIELDS(FIELD)
} WebTournamentState;
#undef FIELD
/* Scalar campaign state only: no pointers, live cars or map-owned objects. */
typedef struct WebTournamentCarry {
    s32 world, progress, games_completed, shared_lives;
    struct {
        s32 lives, wins, losses, eliminated, frags, deaths;
    } players[2];
} WebTournamentCarry;
const WebTournamentCarry* WebTournamentNextStage(void);
int WebTournamentCarryValid(const WebTournamentCarry* carry, s32 world);
void WebTournamentApplyCarry(const WebTournamentCarry* carry);
int WebTournamentActive(void);
WebTournamentState WebTournamentCapture(void);
int WebTournamentStateValid(WebTournamentState state);
void WebTournamentRestore(WebTournamentState state);
WebMatchResult WebTournamentResult(void);
void WebTournamentRestoreResult(WebMatchResult result);
int WebTournamentResultValid(WebMatchResult result, u32 tick, u32 slots);
void WebTournamentCompleteTick(void);
#endif
