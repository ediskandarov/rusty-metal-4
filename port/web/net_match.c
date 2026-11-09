#include "net_match.h"
#include "level.h"
#include "tm4/main/game.h"
#include "tm4/main/pad.h"
#include "tm4/main/registry.h"
#include "tm4/main/system.h"
#include "tm4/modules/car.h"

#include <emscripten.h>
#include <libetc.h>
#include <psyz/input.h>
#include <string.h>

typedef struct NetPadInput {
    u32 axes;
    u16 buttons;
    u8 analog;
} NetPadInput;

static struct {
    NetPadInput inputs[8];
    char* cars[8];
    char* world;
    u32 seed;
    u32 tick;
    u32 input_mask;
    s32 players;
    s32 view_slot;
    int cancelled;
    PadCache physical_pad;
    int start_pending;
    int tick_pending;
} match;

EMSCRIPTEN_KEEPALIVE int WebNetRequestMatch(s32 players, s32 world, u32 seed, s32 view_slot)
{
    static char characters[] = "/objects/car/characters";
    if (match.players || WebLevelActive() || GameInfo.mode != GAME_MODE_MENU
        || players < 2 || players > ArrayCount(match.cars)
        || view_slot < -1 || view_slot >= players
        || world < 0 || world >= GameGetNumberOfWorlds())
        return 0;

    s32 count = RegGetNumberOfDirectoriesS(characters);
    s32 slot = 0;
    for (s32 index = 0; index < count && slot < players; ++index) {
        char* name = RegGetDirectoryNameSN(characters, index);
        if (name && !GameIsBossCar(name))
            match.cars[slot++] = name;
    }
    if (slot != players)
        return 0;

    match.world = GameGetWorldName(world);
    if (!match.world)
        return 0;
    match.seed = seed;
    match.tick = 0;
    match.players = players;
    match.view_slot = view_slot;
    match.cancelled = 0;
    match.start_pending = 1;
    return 1;
}

int WebNetMatchStartPending(void)
{
    if (!match.start_pending)
        return 0;

    match.start_pending = 0;
    WebLeaveMenu();
    GameInfo.player_count = 1;
    GameInfo.extra_player_count = match.players - 1;
    GameInfo.computer_count = 0;
    GameInfo.ally_count = 0;
    GameInfo.pause_player = 0;
    GameInfo.intro_character = NULL;
    GameInfo.world_name = match.world;
    GameInfo.game_type = GAME_TYPE_DEATHMATCH;
    GameInfo.deathmatch_world_selection = DEATHMATCH_WORLD_REPEAT;
    GameInfo.deathmatch_car_selection = DEATHMATCH_OPPONENTS_PLAYER_CHOSEN;
    GameInfo.deathmatch_limit_is_wins = 0;
    GameInfo.deathmatch_limit = 1;
    GameInfo.view_layouts[0] = 0;
    for (s32 slot = 0; slot < match.players; ++slot) {
        GameInfo.character_names[slot] = match.cars[slot];
        GameSetControllerConfigDefault(&GameInfo, slot, 0);
        GameSetControllerConfigDefault(&GameInfo, slot, 1);
    }
    GameInfo.next_mode = GAME_MODE_PLAY;
    WebLevelStart();
    match.physical_pad = PadJpad[0];
    memset(PadJpad, 0, sizeof(PadJpad));
    EM_ASM({ tm4Port.netMatch = ({ players: $0, tick: 0 }); }, match.players);
    return 1;
}

int WebNetMatchActive(void)
{
    return match.players && !match.start_pending;
}

EMSCRIPTEN_KEEPALIVE void WebNetCancelMatch(void)
{
    if (match.start_pending) {
        match.start_pending = 0;
        WebNetMatchEnd();
    } else if (match.players) {
        match.cancelled = 1;
    }
}

int WebNetMatchCancelled(void)
{
    return match.cancelled;
}

int WebNetMatchViewSlot(void)
{
    return match.view_slot;
}

void WebNetMatchPollInput(void)
{
    if (match.view_slot < 0)
        return;

    /* The physical controller has separate history from the server's slot inputs. */
    PadCache simulation_pad = PadJpad[0];
    PadJpad[0] = match.physical_pad;
    PadGetPad(1);
    match.physical_pad = PadJpad[0];
    PadJpad[0] = simulation_pad;

    u32 axes = 0;
    for (s32 axis = 0; axis < ArrayCount(match.physical_pad.axes); ++axis)
        axes |= (u32)match.physical_pad.axes[axis] << (8 * axis);
    EM_ASM(
        { tm4Port.netMatchInput?.($0, $1 >>> 0, !!$2); },
        match.physical_pad.buttons & ~PADstart, axes, match.physical_pad.has_analog);
}

void WebNetMatchSeed(void)
{
    if (WebNetMatchActive()) {
        GameInfo.random_seed = match.seed;
        srand(match.seed);
        srandrand(match.seed);
    }
}

EMSCRIPTEN_KEEPALIVE int WebNetSetInput(u32 tick, s32 slot, u32 buttons, u32 axes, s32 analog)
{
    if (!WebNetMatchActive() || !WebLevelActive() || tick != match.tick || match.tick_pending
        || slot < 0 || slot >= match.players || buttons > 0xffff || (analog != 0 && analog != 1))
        return 0;

    match.inputs[slot] = (NetPadInput) {
        .axes = axes,
        .buttons = buttons & ~PADstart,
        .analog = analog,
    };
    match.input_mask |= 1u << slot;
    return 1;
}

EMSCRIPTEN_KEEPALIVE int WebNetQueueTick(u32 tick)
{
    if (!WebNetMatchActive() || !WebLevelActive() || tick != match.tick || match.tick_pending
        || match.input_mask != (1u << match.players) - 1)
        return 0;

    match.tick_pending = 1;
    return 1;
}

int WebNetMatchTakeInput(void)
{
    if (!match.tick_pending)
        return 0;

    for (s32 slot = 0; slot < match.players; ++slot) {
        const NetPadInput* input = &match.inputs[slot];
        PadCache* pad = &PadJpad[slot];
        pad->device_type = input->analog ? PSYZ_CTRL_ANALOG_PAD : PSYZ_CTRL_DIGITAL_PAD;
        pad->has_analog = input->analog;
        pad->port_id = slot;
        pad->absent_ticks = 0;
        pad->previous_buttons = pad->buttons;
        pad->buttons = input->buttons;
        pad->pressed_buttons = pad->buttons & ~pad->previous_buttons;
        pad->released_buttons = pad->previous_buttons & ~pad->buttons;
        pad->idle_ticks = pad->buttons ? 0 : pad->idle_ticks + 1;
        for (s32 axis = 0; axis < ArrayCount(pad->axes); ++axis) {
            pad->previous_axes[axis] = pad->axes[axis];
            pad->axes[axis] = input->analog ? input->axes >> (8 * axis) : 0;
        }
    }
    match.input_mask = 0;
    match.tick_pending = 0;
    ++match.tick;
    return 1;
}

static u32 match_digest(void)
{
    u32 digest = randseed();
    for (s32 slot = 0; slot < match.players; ++slot) {
        const Car* car = GameInfo.players[slot].car;
        digest = digest * 16777619u ^ (car != NULL);
        if (car) {
            for (s32 axis = 0; axis < 3; ++axis)
                digest = digest * 16777619u ^ (u32)car->transform.t[axis];
            digest = digest * 16777619u ^ (u32)car->health;
        }
    }
    return digest;
}

void WebNetMatchPublishTick(void)
{
    EM_ASM(
        {
            Object.assign(tm4Port.netMatch, {
                tick: $0,
                remaining: $1,
                winner: $2,
                roundFinished: !!$3,
                acceptsContinue: !!$4,
                nextMode: $5,
                scores: [],
                digest: $6 >>> 0
            });
        },
        match.tick, GameInfo.active_player_count, GameInfo.deathmatch_winner,
        GameInfo.deathmatch_finished, GameInfo.deathmatch_accept_input, GameInfo.next_mode,
        match_digest());
    for (s32 slot = 0; slot < match.players; ++slot) {
        const Tm4GamePlayer* player = &GameInfo.players[slot];
        EM_ASM(
            { tm4Port.netMatch.scores.push({ wins: $0, losses: $1 }); },
            player->wins, player->losses);
    }
    EM_ASM({ tm4Port.netMatchTick?.(); });
}

void WebNetMatchEnd(void)
{
    match.players = 0;
    match.input_mask = 0;
    match.tick_pending = 0;
}
