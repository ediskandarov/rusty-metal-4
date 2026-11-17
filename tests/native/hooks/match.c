#include "pending.h"
#include "port/web/car_capacity.h"
#include "port/web/module_import.h"
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

EMSCRIPTEN_KEEPALIVE void WebTestDamagePlayer(void) { defeat_player_pending = 1; }

static int defeat_opponents_pending;
static s32 defeat_opponents_survivors;
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

EMSCRIPTEN_KEEPALIVE void WebTestLoseDeathmatchRound(void) { defeat_player_pending = 1; }

EMSCRIPTEN_KEEPALIVE int WebTestDefeatOtherSlots(s32 winner)
{
    if (!WebNetSlotOccupied(winner))
        return 0;
    sparse_winner_pending = winner + 1;
    return 1;
}

EMSCRIPTEN_KEEPALIVE void WebTestDefeatOpponentsTo(s32 survivors)
{
    defeat_opponents_pending = 1;
    defeat_opponents_survivors = survivors;
}

EMSCRIPTEN_KEEPALIVE void WebTestDefeatOpponents(void) { WebTestDefeatOpponentsTo(0); }

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
            WEB_MODULE("car", CarApplyParticipantDamage)
            (player, NULL, WebParticipantObjectIdentity(NULL), 0x7fffffff, NULL, "DEATHMATCH TEST");
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
            WEB_MODULE("car", CarApplyParticipantDamage)
            (car, winner, WebParticipantObjectIdentity(winner), 0x7fffffff, NULL,
                "SPARSE SLOT TEST");
        }
    }
    if (!defeat_opponents_pending)
        return;
    defeat_opponents_pending = 0;
    s32 survivors = defeat_opponents_survivors;
    Car* player = GameInfo.players[0].car;
    for (s32 i = GameInfo.car_count - 1; i >= 0; --i) {
        Car* car = GameInfo.cars[i];
        if (car->control_kind != CAR_CONTROL_ENEMY || car->health <= 0)
            continue;
        if (survivors > 0) {
            --survivors;
            continue;
        }
        car->shield_ticks = 0;
        WEB_MODULE("car", CarApplyParticipantDamage)
        (car, player, WebParticipantObjectIdentity(player), 0x7fffffff, NULL, "PROGRESSION TEST");
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
                worldSelection : $5,
                bossesSpawned : $6,
                bossesActive : $7,
                bossCount : $8
            });
        },
        GameInfo.deathmatch_accept_input, GameInfo.deathmatch_next_mode, GameInfo.players[0].losses,
        GameInfo.deathmatch_limit, GameInfo.deathmatch_limit_is_wins,
        GameInfo.deathmatch_world_selection, GameInfo.bosses_spawned, GameInfo.bosses_active,
        GameInfo.boss_count);
    EM_ASM(
        { Object.assign(tm4Port.match, { winner : $0, players : [] }); },
        GameInfo.deathmatch_winner);
    for (s32 i = 0; i < (WebNetTournament() ? GameInfo.player_car_count : GameInfo.player_count);
         ++i) {
        EM_ASM(
            {
                tm4Port.match.players.push(
                    { wins : $0, losses : $1, lives : $2, eliminated : !!$3 });
            },
            GameInfo.players[i].wins, GameInfo.players[i].losses, GameInfo.players[i].lives,
            GameInfo.players[i].eliminated);
    }
}

static s32 coop_rules_pending = -1;
static s32 coop_damage_pending = -1;

EMSCRIPTEN_KEEPALIVE s32 WebTestCoopSetup(s32 shared)
{
    if (GameInfo.player_count != 2 && !(WebNetTournament() && GameInfo.player_car_count >= 2))
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
        for (s32 i = 2; i < GameInfo.player_car_count; ++i)
            GameInfo.players[i].lives = 0;
        coop_rules_pending = -1;
        for (s32 i = 0; i < GameInfo.car_count; ++i) {
            Car* car = GameInfo.cars[i];
            if (car->control_kind == CAR_CONTROL_ENEMY) {
                WEB_MODULE("car", CarAiProcessFunctionDisable)(car);
                memset(&car->controls, 0, sizeof(car->controls));
            }
        }
    }
    if (coop_damage_pending >= 0) {
        Car* car = GameInfo.players[coop_damage_pending].car;
        coop_damage_pending = -1;
        if (car) {
            car->shield_ticks = 0;
            WEB_MODULE("car", CarApplyParticipantDamage)
            (car, NULL, WebParticipantObjectIdentity(NULL), 0x7fffffff, NULL, "COOP TEST");
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

/* Read-only rules probe; tests keep original damage, timers and mode logic. */
EMSCRIPTEN_KEEPALIVE const s32* WebTestTournamentState(void)
{
    static s32 state[29];
    const s32 values[] = { GameInfo.computer_count, GameInfo.initial_computer_count,
        GameInfo.reinforcement_threshold, GameInfo.boss_count, GameInfo.reinforcements_spawned,
        GameInfo.bosses_spawned, GameInfo.bosses_active, GameInfo.active_computer_count,
        GameInfo.tournament_progress, GameInfo.games_completed, GameInfo.shared_lives,
        GameInfo.players[0].lives, GameInfo.players[1].lives, GameInfo.players[0].eliminated,
        GameInfo.players[1].eliminated, GameInfo.active_player_count,
        GameInfo.intro_character != NULL, GameInfo.world_won, GameInfo.tournament_won,
        GameInfo.world_lost, GameInfo.tournament_accept_input, GameInfo.players[2].lives,
        GameInfo.players[3].lives, GameInfo.players[2].eliminated, GameInfo.players[3].eliminated,
        GameInfo.entrant_count, GameInfo.car_count, GameInfo.player_car_count,
        WebNetCarCapacity() };
    memcpy(state, values, sizeof(state));
    return state;
}

/* Exercise the real radar writer and GPU packets beyond the original eight cars.
 * Synthetic cars share a loaded area's metadata; no simulation objects are spawned. */
void ScreenDisplayRadar(Car*, Car*, ScreenPlayerPrims*, Tm4OrderingTag*);

EMSCRIPTEN_KEEPALIVE int WebTestCarAtlasCapacity(void) { return TM4_CAR_ATLAS_COUNT; }

EMSCRIPTEN_KEEPALIVE int WebTestRadarCapacity(s32 count)
{
    static struct {
        Tm4ObjectHeader header;
        Car car;
    } objects[TM4_MAX_LIVE_CARS];
    _Static_assert(offsetof(__typeof__(objects[0]), car) == sizeof(Tm4ObjectHeader),
        "radar fixture object header");
    struct {
        u32 before;
        ScreenPlayerPrims packets;
        u32 after;
    } guarded;
    ScreenPlayerPrims original;
    Tm4RenderBuffer* buffer = RenderGetDrawBuffer();
    Car* source = GameInfo.players[0].car;
    if (!buffer || !source || count < 9 || count > TM4_MAX_LIVE_CARS)
        return 1;
    for (s32 view = 0; view < ArrayCount(buffer->players); ++view) {
        ScreenPlayerPrims* packets = &buffer->players[view];
        for (s32 i = 0; i < TM4_MAX_LIVE_CARS; ++i)
            if ((getcode(&packets->radar_dots[i]) & ~2) != 0x60 || packets->radar_dots[i].w != 2
                || packets->radar_dots[i].h != 2)
                return 2;
        if ((getcode(&packets->radar_center) & ~2) != 0x60)
            return 3;
    }
    guarded.before = guarded.after = 0xcafef00d;
    guarded.packets = original = buffer->players[0];
    Car* saved[TM4_MAX_LIVE_CARS];
    memcpy(saved, GameInfo.cars, sizeof(saved));
    const s32 saved_count = GameInfo.car_count;
    memset(objects, 0, sizeof(objects));
    for (s32 i = 0; i < count; ++i) {
        objects[i].car.ai.area = source->ai.area;
        objects[i].car.transform.m[2][2] = 4096;
        objects[i].header.position.vx = i ? (i - 4) * 1024 : 0;
        objects[i].car.radar_color.r = i == 9 ? 0 : 248;
        objects[i].car.radar_color.g = i == 9 ? 248 : 0;
        GameInfo.cars[i] = &objects[i].car;
    }
    GameInfo.car_count = count;
    Tm4OrderingTag ordering;
    ClearOTagR(&ordering, 1);
    const u32 end_tag = getaddr(&ordering);
    ScreenDisplayRadar(&objects[0].car, &objects[count - 1].car, &guarded.packets, &ordering);
    GameInfo.car_count = saved_count;
    memcpy(GameInfo.cars, saved, sizeof(saved));
    int failure = guarded.before != 0xcafef00d || guarded.after != 0xcafef00d;
    const size_t start = offsetof(ScreenPlayerPrims, radar_dots);
    const size_t end = start + sizeof(original.radar_dots);
    failure |= memcmp(&guarded.packets, &original, start) != 0;
    failure |= memcmp((char*)&guarded.packets + end, (char*)&original + end, sizeof(original) - end)
        != 0;
    Tm4OrderingTag* packet = (Tm4OrderingTag*)getaddr(&ordering);
    for (s32 i = count - 1; i > 0; --i) {
        if (packet != (Tm4OrderingTag*)&guarded.packets.radar_dots[i])
            return 4;
        packet = (Tm4OrderingTag*)getaddr(packet);
    }
    if ((u32)packet != end_tag)
        return 5;
    DRAWENV saved_draw, draw;
    GetDrawEnv(&saved_draw);
    SetDefDrawEnv(&draw, 0, 0, 320, 240);
    draw.isbg = 0;
    PutDrawEnv(&draw);
    RECT background = { 0, 0, 320, 240 };
    ClearImage(&background, 0, 0, 0);
    DR_TPAGE page;
    SetDrawTPage(&page, 0, 0, GetTPage(0, 1, 0, 0));
    DrawPrim(&page);
    DrawOTag(&ordering);
    for (s32 i = 8; i < count; ++i) {
        RECT pixel = { 35 + (i - 4) * 2, 50, 2, 1 };
        u_long pixels = 0;
        StoreImage(&pixel, &pixels);
        DrawSync(0);
        failure |= (pixels & 0x7fff) != (i == 9 ? 0x03e0 : 0x001f);
    }
    PutDrawEnv(&saved_draw);
    return failure ? 6 : 0;
}
