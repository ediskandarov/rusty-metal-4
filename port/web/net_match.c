#include "net_match.h"
#include "net_state.h"
#include "checkpoint.h"
#include "cheats.h"
#include "level.h"
#include "tm4/main/game.h"
#include "tm4/main/pad.h"
#include "tm4/main/registry.h"
#include "tm4/main/system.h"
#include "rollback_audio.h"
#include "tm4/modules/car.h"

#include "tm4/main/loadfiles.h"
#include <ctype.h>
#include <emscripten.h>
#include <libetc.h>
#include <psyz/input.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

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
    PadCache physical_pad;
    int tick_pending;
    int stepping;
    int replaying;
    int local_replaying;
    u32 checkpoint_tick;
} match;

static char* configured_cars[8];
static int rendered_prediction;
static void start_session(void);

EMSCRIPTEN_KEEPALIVE int WebNetSelectCar(s32 slot, const char* name)
{
    if (match.players || slot < 0 || slot >= 8 || !name)
        return 0;
    const s32 count = RegGetNumberOfDirectoriesS("/objects/car/characters");
    for (s32 i = 0; i < count; ++i) {
        char* candidate = RegGetDirectoryNameSN("/objects/car/characters", i);
        if (candidate && !strcmp(candidate, name) && !GameIsBossCar(candidate)) {
            configured_cars[slot] = candidate;
            return 1;
        }
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE int WebNetWorldIndex(const char* name)
{
    for (s32 i = 0; i < GameGetNumberOfWorlds(); ++i)
        if (!strcmp(name, GameGetWorldName(i)))
            return i;
    return -1;
}

void WebNetPublishCatalog(void)
{
    EM_ASM({ tm4Port.catalog = ({ worlds : [], cars : [] }); });
    for (s32 i = 0; i < GameGetNumberOfWorlds(); ++i)
        EM_ASM({ tm4Port.catalog.worlds.push(UTF8ToString($0)); }, GameGetWorldName(i));
    const s32 count = RegGetNumberOfDirectoriesS("/objects/car/characters");
    for (s32 i = 0; i < count; ++i) {
        char* name = RegGetDirectoryNameSN("/objects/car/characters", i);
        if (name && !GameIsBossCar(name))
            EM_ASM({ tm4Port.catalog.cars.push(UTF8ToString($0)); }, name);
    }
}

static int reject_start(const char* message)
{
    EM_ASM({ tm4Port.netSession = ({ status : "error", message : UTF8ToString($0) }); }, message);
    return 0;
}

static int session_resources_present(s32 players)
{
    /* Validate file presence before mutating session state; a rejected start is retryable. */
    const char* common[] = { "/DATA/GAME.MR", "/DATA/GAME.IMG", "/DATA/GAME.VAB" };
    for (unsigned i = 0; i < ArrayCount(common); ++i)
        if (access(common[i], R_OK))
            return reject_start(common[i]);
    for (s32 i = -1; i < players; ++i) {
        RegistryDirectory* directory = i < 0 ? GameGetWorldNameDirectoryPtr(match.world)
                                             : GetMatchingCarDirectory(match.cars[i], NULL);
        const char* name = directory ? RegGetFileDataPS(directory, "filename") : NULL;
        char path[128];
        if (!name || snprintf(path, sizeof(path), "/DATA/%s.MR", name) >= sizeof(path))
            return 0;
        for (char* ch = path; *ch; ++ch)
            *ch = toupper((unsigned char)*ch);
        if (access(path, R_OK)) {
            fprintf(stderr, "Missing session resource: %s\n", path);
            return reject_start(path);
        }
        if (i < 0) {
            snprintf(path, sizeof(path), "/DATA/%s.IMG", name);
            for (char* ch = path; *ch; ++ch)
                *ch = toupper((unsigned char)*ch);
            if (access(path, R_OK))
                return reject_start(path);
        }
    }
    return 1;
}

EMSCRIPTEN_KEEPALIVE int WebNetRequestMatch(s32 players, s32 world, u32 seed, s32 view_slot)
{
    static char characters[] = "/objects/car/characters";
    if (match.players || WebLevelActive() || players < 2 || players > ArrayCount(match.cars)
        || view_slot < -1 || view_slot >= players || world < 0 || world >= GameGetNumberOfWorlds())
        return reject_start("Invalid match configuration or session already running");

    s32 count = RegGetNumberOfDirectoriesS(characters);
    s32 slot = 0;
    for (s32 index = 0; index < count && slot < players; ++index) {
        char* name = RegGetDirectoryNameSN(characters, index);
        if (name && !GameIsBossCar(name))
            match.cars[slot++] = name;
    }
    if (slot != players)
        return 0;
    for (s32 i = 0; i < players; ++i)
        if (configured_cars[i])
            match.cars[i] = configured_cars[i];

    match.world = GameGetWorldName(world);
    if (!match.world)
        return 0;
    if (!session_resources_present(players))
        return 0;
    match.seed = seed;
    match.tick = 0;
    match.players = players;
    match.view_slot = view_slot;
    EM_ASM({
        tm4Port.networkSynchronous = true;
        tm4Port.netSession = ({ status : "loading" });
    });
    start_session();
    return 1;
}

static void start_session(void)
{
    WebLeaveMenu();
    memset(&GameInfo, 0, sizeof(GameInfo));
    GameInitialize();
    WebResetNetworkCheats();
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
    match.physical_pad = (PadCache) { 0 };
    memset(PadJpad, 0, sizeof(PadJpad));
    EM_ASM(
        {
            tm4Port.netSession = ({ status : "ready" });
            tm4Port.netMatch = ({ players : $0, tick : 0, status : "ready" });
        },
        match.players);
    WebNetMatchPublishTick();
}

static const char* checkpoint_resource_blocker(void)
{
    if (EM_ASM_INT({ return !!Module.tm4CodeMods?.size; }))
        return "independent module state";
    if (GameInfo.game_type != GAME_TYPE_DEATHMATCH || GameInfo.computer_count != 0)
        return "game mode state";
    if (strcmp(match.world, "Construction Yard"))
        return "map state";
    return NULL;
}

EMSCRIPTEN_KEEPALIVE int WebNetEnableRenderedPrediction(void)
{
    if (match.players || WebLevelActive() || WebAuthorityStartup()
        || EM_ASM_INT({ return !!Module.tm4ResourceMods || !!Module.tm4CodeMods?.size; }))
        return 0;
    rendered_prediction = 1;
    return 1;
}

int WebNetRenderedPrediction(void)
{
    return rendered_prediction && match.players && match.view_slot >= 0;
}

int WebNetLocalCheckpointSupported(void)
{
    return match.players && !checkpoint_resource_blocker()
        && (WebNetRenderedPrediction() || (match.view_slot < 0 && WebAuthorityStartup()
            && EM_ASM_INT({ return Module.tm4LocalCheckpoint && !Module.tm4ResourceMods; })));
}

static int local_checkpoint_boundary(void)
{
    return WebNetLocalCheckpointSupported() && WebLevelCheckpointActive() && WebLevelActive()
        && !match.replaying && !match.stepping && !match.tick_pending && !match.input_mask;
}

static int local_checkpoint_error(const char* message)
{
    EM_ASM({ tm4Port.localCheckpointError = $0 ? UTF8ToString($0) : null; }, message);
    return 0;
}

EMSCRIPTEN_KEEPALIVE u32 WebNetCaptureLocalCheckpoint(void)
{
    if (!local_checkpoint_boundary() || match.local_replaying)
        return local_checkpoint_error(
            "capture requires a supported match at a live tick boundary");
    u32 size = WebCheckpointCapture(match.tick, 0);
    if (!size)
        return local_checkpoint_error("simulation state or checkpoint capacity rejected capture");
    match.checkpoint_tick = match.tick;
    local_checkpoint_error(NULL);
    return size;
}

EMSCRIPTEN_KEEPALIVE u32 WebNetRetainLocalCheckpoint(u32 tick)
{
    if (!local_checkpoint_boundary() || tick != match.tick)
        return local_checkpoint_error("checkpoint capture tick does not match the simulation boundary");
    const u32 size = WebCheckpointCapture(tick, 1);
    if (!size)
        return local_checkpoint_error("simulation state or checkpoint history rejected capture");
    local_checkpoint_error(NULL);
    return size;
}

EMSCRIPTEN_KEEPALIVE u32 WebNetLocalCheckpointStorageBytes(void)
{
    return WebCheckpointStorageBytes();
}

EMSCRIPTEN_KEEPALIVE u32 WebNetLocalRollbackDepth(void)
{
    return WebCheckpointHistoryTicks;
}

EMSCRIPTEN_KEEPALIVE int WebNetRestoreLocalTick(u32 tick)
{
    if (!local_checkpoint_boundary())
        return local_checkpoint_error(
            "restore requires a supported match at a tick boundary");
    if (WebNetRenderedPrediction())
        WebRollbackAudioRemember();
    const char* blocker = WebCheckpointRestore(tick);
    if (blocker)
        return local_checkpoint_error(blocker);
    if (WebNetRenderedPrediction())
        WebRollbackAudioDetach();
    match.local_replaying = 1;
    match.tick = tick;
    local_checkpoint_error(NULL);
    WebNetMatchPublishTick();
    return 1;
}

EMSCRIPTEN_KEEPALIVE int WebNetRestoreLocalCheckpoint(void)
{
    return WebNetRestoreLocalTick(match.checkpoint_tick);
}

EMSCRIPTEN_KEEPALIVE int WebNetFinishLocalReplay(void)
{
    if (!local_checkpoint_boundary() || !match.local_replaying)
        return local_checkpoint_error("replay must finish at a tick boundary");
    if (WebNetRenderedPrediction())
        WebRollbackAudioReconcile();
    match.local_replaying = 0;
    local_checkpoint_error(NULL);
    return 1;
}

EMSCRIPTEN_KEEPALIVE int WebNetCaptureState(void)
{
    static u8 buffer[256 * 1024];
    u32 length = 0;
    if (WebNetMatchActive() && WebLevelActive() && !match.tick_pending && !match.input_mask
        && !checkpoint_resource_blocker())
        length = WebNetCaptureBytes(buffer, sizeof(buffer));
    EM_ASM(
        {
            if ($1)
                tm4Port.netCapturedState = HEAPU8.slice($0, $0 + $1);
            else
                delete tm4Port.netCapturedState;
        },
        buffer, length);
    return length;
}

int WebNetReplaying(void)
{
    return match.replaying || match.local_replaying;
}

EMSCRIPTEN_KEEPALIVE int WebNetBeginReplay(void)
{
    if (!WebNetMatchActive() || !WebLevelActive() || WebNetReplaying() || match.stepping
        || match.tick_pending || match.input_mask || checkpoint_resource_blocker())
        return 0;

    RegistryDirectory* directory = RegGetCurrentDirectoryPtr();
    int resources_present = session_resources_present(match.players);
    RegChangeCurrentDirectoryP(directory);
    if (!resources_present)
        return 0;

    match.replaying = 1;
    WebLevelStop();
    match.tick = 0;
    start_session();
    return 1;
}

EMSCRIPTEN_KEEPALIVE void WebNetEndReplay(void)
{
    if (match.replaying)
        WebNetSuppressReplayedSounds();
    match.replaying = 0;
}

int WebNetMatchActive(void)
{
    return match.players != 0;
}

EMSCRIPTEN_KEEPALIVE void WebNetCancelMatch(void)
{
    if (match.players) {
        WebLevelStop();
        WebNetMatchEnd();
    } else {
        rendered_prediction = 0;
    }
}

int WebNetLocalViewCount(void)
{
    return WebNetMatchActive() ? (match.view_slot >= 0) : GameInfo.player_count;
}

int WebNetGameplaySlot(int view)
{
    return WebNetMatchActive() ? match.view_slot : view;
}

int WebNetLocalView(int slot)
{
    return WebNetMatchActive() ? (slot == match.view_slot ? 0 : -1) : slot;
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
        { tm4Port.netMatchInput ?.($0, $1 >>> 0, !!$2); }, match.physical_pad.buttons & ~PADstart,
        axes, match.physical_pad.has_analog);
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
    if (!WebNetMatchActive() || !WebLevelActive() || tick != match.tick || match.stepping
        || match.tick_pending
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
    if (!WebNetMatchActive() || !WebLevelActive() || tick != match.tick || match.stepping
        || match.tick_pending
        || match.input_mask != (1u << match.players) - 1)
        return 0;

    match.tick_pending = 1;
    match.stepping = 1;
    WebLevelNetworkStep();
    match.stepping = 0;
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

void WebNetMatchPublishTick(void)
{
    const char* unsupported = checkpoint_resource_blocker();
    const WebNetStateDigest state = WebNetCaptureDigest(!unsupported);
    u32 digest = state.session;
    digest = (digest ^ state.cars) * 16777619u;
    digest = (digest ^ state.objects) * 16777619u;
    digest = (digest ^ state.world) * 16777619u;
    digest = (digest ^ state.sound) * 16777619u;
    if (!unsupported)
        unsupported = state.unsupported;
    if (unsupported && WebLevelCheckpointActive())
        WebCheckpointRejectState();
    EM_ASM(
        {
            Object.assign(tm4Port.netMatch, {
                tick : $0,
                remaining : $1,
                winner : $2,
                roundFinished : !!$3,
                acceptsContinue : !!$4,
                nextMode : $5,
                scores : [],
                digest : $6 >>> 0,
                sections : [ $7 >>> 0, $8 >>> 0, $9 >>> 0, $10 >>> 0, $11 >>> 0 ],
                unsupported : $12 ? UTF8ToString($12) : null
            });
        },
        match.tick, GameInfo.active_player_count, GameInfo.deathmatch_winner,
        GameInfo.deathmatch_finished, GameInfo.deathmatch_accept_input, GameInfo.next_mode,
        digest, state.session, state.cars, state.objects, state.world, state.sound, unsupported);
    for (s32 slot = 0; slot < match.players; ++slot) {
        const Tm4GamePlayer* player = &GameInfo.players[slot];
        EM_ASM(
            { tm4Port.netMatch.scores.push({ wins : $0, losses : $1 }); }, player->wins,
            player->losses);
    }
    if (match.tick && !WebNetReplaying())
        EM_ASM({ tm4Port.netMatchTick ?.(); });
}

void WebNetMatchEnd(void)
{
    rendered_prediction = 0;
    memset(&match, 0, sizeof(match));
    memset(configured_cars, 0, sizeof(configured_cars));
    EM_ASM({
        delete tm4Port.netMatch;
        delete tm4Port.netCapturedState;
        delete tm4Port.localCheckpointError;
        tm4Port.networkSynchronous = false;
    });
}
