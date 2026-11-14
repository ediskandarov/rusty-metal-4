#include "pending.h"
#include "port/web/net_match.h"
#include "src/modules/car/private.h"
#include "tm4/main/game.h"
#include "tm4/main/object.h"
#include "tm4/main/screen.h"
#include "tm4/main/tournament.h"
#include "tm4/modules/camera.h"
#include <emscripten.h>
#include <string.h>

static int defeat_player_pending;

EMSCRIPTEN_KEEPALIVE void WebTestDamagePlayer(void)
{
    defeat_player_pending = 1;
}

static int defeat_opponents_pending;
static int sparse_winner_pending;
static int deathmatch_rules_pending;
static int deathmatch_test_wins, deathmatch_test_limit, deathmatch_test_advance;

EMSCRIPTEN_KEEPALIVE void WebTestDeathmatchRules(s32 wins, s32 limit, s32 advance)
{
    deathmatch_test_wins = wins;
    deathmatch_test_limit = limit;
    deathmatch_test_advance = advance;
    deathmatch_rules_pending = 1;
}

EMSCRIPTEN_KEEPALIVE void WebTestLoseDeathmatchRound(void)
{
    defeat_player_pending = 1;
}

EMSCRIPTEN_KEEPALIVE int WebTestDefeatOtherSlots(s32 winner)
{
    if (!WebNetSlotOccupied(winner))
        return 0;
    sparse_winner_pending = winner + 1;
    return 1;
}

EMSCRIPTEN_KEEPALIVE void WebTestDefeatOpponents(void)
{
    defeat_opponents_pending = 1;
}

static s32 test_hud_slot;
static s32 test_hud_count;

EMSCRIPTEN_KEEPALIVE void WebTestNetworkHudMessages(s32 slot, s32 count)
{
    test_hud_slot = slot;
    test_hud_count = count;
}

void WebTestApplyHudMessages(void)
{
    for (s32 i = 0; i < test_hud_count && i < 3; ++i)
        ScreenLocalMessageRegister(test_hud_slot, "ROLLBACK TEST %d", i + 1);
    test_hud_count = 0;
}

void WebTestApplyMatchActions(void)
{
    if (deathmatch_rules_pending) {
        deathmatch_rules_pending = 0;
        GameInfo.deathmatch_limit_is_wins = deathmatch_test_wins;
        GameInfo.deathmatch_limit = deathmatch_test_limit;
        GameInfo.deathmatch_world_selection = deathmatch_test_advance;
    }
    if (defeat_player_pending) {
        defeat_player_pending = 0;
        Car* player = GameInfo.players[0].car;
        if (player) {
            player->shield_ticks = 0;
            CarApplyParticipantDamage(player, NULL, WebParticipantObjectIdentity(NULL), 0x7fffffff,
                NULL, "DEATHMATCH TEST");
        }
    }
    if (sparse_winner_pending) {
        Car* winner = GameInfo.players[sparse_winner_pending - 1].car;
        sparse_winner_pending = 0;
        for (s32 i = GameInfo.car_count - 1; i >= 0; --i) {
            Car* car = GameInfo.cars[i];
            if (car == winner || car->health <= 0)
                continue;
            car->shield_ticks = 0;
            CarApplyParticipantDamage(car, winner, WebParticipantObjectIdentity(winner), 0x7fffffff,
                NULL, "SPARSE SLOT TEST");
        }
    }
    if (!defeat_opponents_pending)
        return;
    defeat_opponents_pending = 0;
    Car* player = GameInfo.players[0].car;
    for (s32 i = GameInfo.car_count - 1; i >= 0; --i) {
        Car* car = GameInfo.cars[i];
        if (car->control_kind != CAR_CONTROL_ENEMY || car->health <= 0)
            continue;
        car->shield_ticks = 0;
        CarApplyParticipantDamage(car, player, WebParticipantObjectIdentity(player), 0x7fffffff,
            NULL, "PROGRESSION TEST");
    }
}

EMSCRIPTEN_KEEPALIVE void WebTestReadMatchState(void)
{
    EM_ASM(
        {
            tm4Port.match = ({
                won : $0,
                lost : $1,
                acceptsInput : $2,
                progress : $3,
                lives : $4,
                opponents : $5,
                mode : $6,
                nextMode : $7,
                rounds : $8,
                roundFinished : $9,
                wins : $10,
                world : UTF8ToString($11),
                saveMenu : $12,
                tournamentWon : $13,
                tournamentWorlds : $14
            });
        },
        GameInfo.world_won, GameInfo.world_lost, GameInfo.tournament_accept_input,
        GameInfo.tournament_progress, GameInfo.players[0].lives, GameInfo.active_computer_count,
        GameInfo.mode, GameInfo.next_mode, GameInfo.deathmatch_rounds, GameInfo.deathmatch_finished,
        GameInfo.players[0].wins, GameInfo.world_name, GameInfo.save_menu, GameInfo.tournament_won,
        GameGetNumberOfTournamentWorlds());
    EM_ASM(
        {
            Object.assign(tm4Port.match, {
                deathmatchAcceptsInput : $0,
                deathmatchNextMode : $1,
                losses : $2,
                limit : $3,
                limitIsWins : $4,
                worldSelection : $5
            });
        },
        GameInfo.deathmatch_accept_input, GameInfo.deathmatch_next_mode, GameInfo.players[0].losses,
        GameInfo.deathmatch_limit, GameInfo.deathmatch_limit_is_wins,
        GameInfo.deathmatch_world_selection);
    EM_ASM(
        { Object.assign(tm4Port.match, { winner : $0, players : [] }); },
        GameInfo.deathmatch_winner);
    for (s32 i = 0; i < GameInfo.player_count; ++i) {
        EM_ASM(
            { tm4Port.match.players.push({ wins : $0, losses : $1 }); }, GameInfo.players[i].wins,
            GameInfo.players[i].losses);
    }
}

static s32 coop_rules_pending = -1;
static s32 coop_damage_pending = -1;

EMSCRIPTEN_KEEPALIVE s32 WebTestCoopSetup(s32 shared)
{
    if (GameInfo.player_count != 2)
        return 0;
    coop_rules_pending = !!shared;
    return 1;
}

EMSCRIPTEN_KEEPALIVE void WebTestCoopDamage(s32 player)
{
    if (player >= 0 && player < GameInfo.player_count)
        coop_damage_pending = player;
}

void WebTestApplyCoopActions(void)
{
    if (coop_rules_pending >= 0) {
        GameInfo.shared_lives = coop_rules_pending;
        GameInfo.players[0].lives = 0;
        GameInfo.players[1].lives = 1;
        coop_rules_pending = -1;
        for (s32 i = 0; i < GameInfo.car_count; ++i) {
            Car* car = GameInfo.cars[i];
            if (car->control_kind == CAR_CONTROL_ENEMY) {
                CarAiProcessFunctionDisable(car);
                memset(&car->controls, 0, sizeof(car->controls));
            }
        }
    }
    if (coop_damage_pending >= 0) {
        Car* car = GameInfo.players[coop_damage_pending].car;
        coop_damage_pending = -1;
        if (car) {
            car->shield_ticks = 0;
            CarApplyParticipantDamage(
                car, NULL, WebParticipantObjectIdentity(NULL), 0x7fffffff, NULL, "COOP TEST");
        }
    }
}

EMSCRIPTEN_KEEPALIVE void WebTestReadCoop(void)
{
    EM_ASM(
        { tm4Port.coop = ({ shared : $0, lost : $1, players : [] }); }, GameInfo.shared_lives,
        GameInfo.world_lost);
    for (s32 i = 0; i < GameInfo.player_count; ++i) {
        Car* car = GameInfo.players[i].car;
        Camera* camera = GameInfo.players[i].camera;
        EM_ASM(
            {
                tm4Port.coop.players.push({
                    alive : !!$0,
                    lives : $1,
                    eliminated : !!$2,
                    camera : !!$3,
                    attached : !!$4
                });
            },
            car != NULL, GameInfo.players[i].lives, GameInfo.players[i].eliminated, camera != NULL,
            car && camera && camera->object == car);
    }
}
