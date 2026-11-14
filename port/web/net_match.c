#include "net_match.h"
#include "ffa.h"
#include "cheats.h"
#include "checkpoint.h"
#include "checkpoint_memory.h"
#include "interpolation.h"
#include "level.h"
#include "net_state.h"
#include "participant.h"
#include "rollback_audio.h"
#include "snapshot.h"
#include "snapshot_world.h"
#include "src/main/object/private.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"
#include "tm4/main/pad.h"
#include "tm4/main/registry.h"
#include "tm4/main/system.h"
#include "tm4/modules/car.h"
#include <stdlib.h>

#include "port/web/browser_report.h"
#include "tm4/main/loadfiles.h"
#include <ctype.h>
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

typedef struct NetMatchSetup {
    s32 capacity;
    u32 slots;
    char* cars[8];
    char* model_pool[8];
    u32 model_count;
    char* world;
    u32 seed;
    s32 view_slot;
    u32 flags;
    u32 respawn_delay_ticks;
    u32 time_limit_ticks, frag_limit;
} NetMatchSetup;

static struct {
    NetMatchSetup setup;
    WebParticipantState initial_participants;
    NetPadInput inputs[8];
    u32 tick;
    u32 input_mask;
    PadCache physical_pad;
    int tick_pending;
    int stepping;
    int replaying;
    int local_replaying;
    int departing;
    u32 checkpoint_tick;
} match;

static void start_session(void);
void WebCheckpointSetRandomState(u32 random, u32 effects);

EMSCRIPTEN_KEEPALIVE int WebNetWorldIndex(const char* name)
{
    for (s32 i = 0; i < GameGetNumberOfWorlds(); ++i)
        if (!strcmp(name, GameGetWorldName(i)))
            return i;
    return -1;
}

void WebNetPublishCatalog(void)
{
    WEB_BROWSER_REPORT({ tm4Port.catalog = ({ worlds : [], cars : [] }); });
    for (s32 i = 0; i < GameGetNumberOfWorlds(); ++i)
        WEB_BROWSER_REPORT({ tm4Port.catalog.worlds.push(UTF8ToString($0)); }, GameGetWorldName(i));
    const s32 count = RegGetNumberOfDirectoriesS("/objects/car/characters");
    for (s32 i = 0; i < count; ++i) {
        char* name = RegGetDirectoryNameSN("/objects/car/characters", i);
        if (name)
            WEB_BROWSER_REPORT({ tm4Port.catalog.cars.push(UTF8ToString($0)); }, name);
    }
}

static int reject_start(const char* message)
{
    WEB_BROWSER_REPORT(
        { tm4Port.netSession = ({ status : "error", message : UTF8ToString($0) }); }, message);
    return 0;
}

static int session_resources_present(const NetMatchSetup* setup)
{
    /* Validate file presence before mutating session state; a rejected start is retryable. */
    const char* common[] = { "/DATA/GAME.MR", "/DATA/GAME.IMG", "/DATA/GAME.VAB" };
    for (unsigned i = 0; i < ArrayCount(common); ++i)
        if (access(common[i], R_OK))
            return reject_start(common[i]);
    for (s32 i = -1; i < (s32)setup->model_count; ++i) {
        RegistryDirectory* directory = i < 0 ? GameGetWorldNameDirectoryPtr(setup->world)
                                             : GetMatchingCarDirectory(setup->model_pool[i], NULL);
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

u32 WebNetModelCount(void)
{
    return match.setup.model_count;
}
char* WebNetModelName(u32 index)
{
    return index < match.setup.model_count ? match.setup.model_pool[index] : NULL;
}
void WebNetModelPool(char output[8][64])
{
    memset(output, 0, 8 * 64);
    for (u32 i = 0; i < match.setup.model_count; ++i)
        strcpy(output[i], match.setup.model_pool[i]);
}

int WebNetSlotCapacity(void)
{
    return match.setup.capacity;
}
EMSCRIPTEN_KEEPALIVE int WebNetSlotMask(void)
{
    WebParticipantState participants;
    WebParticipantCapture(&participants);
    u32 mask = 0;
    for (s32 slot = 0; slot < match.setup.capacity; ++slot)
        if (participants.slots[slot].id.low || participants.slots[slot].id.high)
            mask |= 1u << slot;
    return mask;
}
int WebNetSlotOccupied(int slot)
{
    return slot >= 0 && slot < match.setup.capacity && (WebNetSlotMask() & (1u << slot));
}
/* The live car list is dense; player roots and controller indices are actual slots. */
int WebNetParticipantSlot(int index)
{
    if (!WebNetMatchActive())
        return index;
    for (int slot = 0; slot < match.setup.capacity; ++slot)
        if (WebNetSlotOccupied(slot) && index-- == 0)
            return slot;
    return -1;
}

void WebNetInitialParticipantIds(u32 output[16])
{
    for (s32 slot = 0; slot < 8; ++slot) {
        output[slot * 2] = match.initial_participants.slots[slot].id.low;
        output[slot * 2 + 1] = match.initial_participants.slots[slot].id.high;
    }
}

EMSCRIPTEN_KEEPALIVE u32 WebNetParticipantIdentityPart(s32 slot, s32 part)
{
    const WebParticipantId id = WebParticipantIdentity(slot);
    return part == 0 ? id.low : part == 1 ? id.high : 0;
}

int WebNetParticipantModelsValid(const WebParticipantState* state, u32 slots)
{
    if (!WebParticipantStateValid(state, slots) || (slots & ~((1u << match.setup.capacity) - 1)))
        return 0;
    const u32 prepared = match.setup.model_count;
    for (s32 slot = 0; slot < 8; ++slot)
        if (state->models[slot] > prepared)
            return 0;
    return 1;
}

void WebNetRestoreParticipantConfiguration(void)
{
    WebParticipantState participants;
    WebParticipantCapture(&participants);
    s32 entrant = 0;
    memset(GameInfo.character_names, 0, sizeof(GameInfo.character_names));
    for (s32 slot = 0; slot < match.setup.capacity; ++slot) {
        if (!WebNetSlotOccupied(slot))
            continue;
        GameInfo.character_names[entrant] = match.setup.model_pool[participants.models[slot] - 1];
        if (GameInfo.players[slot].car)
            GameInfo.players[slot].car->index = entrant;
        ++entrant;
    }
    GameInfo.player_car_count = entrant;
    GameInfo.entrant_count = entrant;
    GameInfo.extra_player_count = entrant ? entrant - 1 : 0;
}

static int membership_boundary(u32 tick)
{
    return WebNetMatchActive() && WebLevelActive() && tick == match.tick && !match.stepping
        && !match.tick_pending && !match.input_mask && GameInfo.active
        && GameInfo.mode == GAME_MODE_PLAY && !GameInfo.next_mode;
}

static u32 admission_model(u32 tick, s32 slot, u32 low, u32 high, const char* model)
{
    if (!membership_boundary(tick) || GameInfo.deathmatch_finished || slot < 0
        || slot >= match.setup.capacity || WebNetSlotOccupied(slot) || (!low && !high) || !model)
        return 0;
    WebParticipantState previous;
    WebParticipantCapture(&previous);
    for (s32 i = 0; i < 8; ++i)
        if (previous.slots[i].id.low == low && previous.slots[i].id.high == high)
            return 0;
    u32 prepared_model = 0;
    for (s32 i = 0; i < match.setup.model_count; ++i)
        if (!strcmp(match.setup.model_pool[i], model)) {
            prepared_model = i + 1;
            break;
        }
    return prepared_model;
}

EMSCRIPTEN_KEEPALIVE int WebNetAdmissionValid(
    u32 tick, s32 slot, u32 low, u32 high, const char* model)
{
    return admission_model(tick, slot, low, high, model) != 0;
}

EMSCRIPTEN_KEEPALIVE int WebNetAdmitParticipant(
    u32 tick, s32 slot, u32 low, u32 high, const char* model)
{
    const u32 prepared_model = admission_model(tick, slot, low, high, model);
    if (!prepared_model)
        return 0;
    WebParticipantState previous;
    WebParticipantCapture(&previous);
    const u32 serial = ObjectNextSerial;
    const u32 random = randseed(), effects = WebRenderEffectRandomState();
    RegistryDirectory* directory = RegGetCurrentDirectoryPtr();
    const Tm4GamePlayer old_player = GameInfo.players[slot];
    const PadCache old_pad = PadJpad[slot];
    WebParticipantState candidate = previous;
    candidate.slots[slot] = (WebParticipantResult) { .id = { low, high } };
    candidate.respawns[slot] = (WebParticipantRespawn) { .state = WebCarWaiting };
    candidate.models[slot] = prepared_model;
    /* Preparation is invisible outside this synchronous transaction. Resources
     * come only from the startup pool already loaded on every simulating peer. */
    WebCheckpointArenaSelect(WebLevelCheckpointActive());
    WebParticipantRestore(&candidate);
    GameInfo.players[slot] = (Tm4GamePlayer) { 0 };
    PadJpad[slot] = (PadCache) { 0 };
    GameSetControllerConfigDefault(&GameInfo, slot, 0);
    GameSetControllerConfigDefault(&GameInfo, slot, 1);
    WebNetRestoreParticipantConfiguration();
    GameInfo.players[slot].camera = ObjectCreate("camera", 0, NULL);
    if (GameInfo.players[slot].camera) {
        s32 entrant = 0;
        while (WebNetParticipantSlot(entrant) != slot)
            ++entrant;
        GameSpawnCar(entrant, 0, 0, 0, 0, 0, 0, 0);
    }
    const int admitted = GameInfo.players[slot].car != NULL;
    if (admitted) {
        WebParticipantCapture(&candidate);
        candidate.respawns[slot] = (WebParticipantRespawn) { .state = WebCarActive };
        WebParticipantRestore(&candidate);
    } else {
        if (GameInfo.players[slot].camera)
            ObjectDestroy(GameInfo.players[slot].camera);
        GameInfo.players[slot] = old_player;
        PadJpad[slot] = old_pad;
        WebParticipantRestore(&previous);
        WebNetRestoreParticipantConfiguration();
        ObjectNextSerial = serial;
        WebCheckpointSetRandomState(random, effects);
    }
    WebCheckpointArenaSelect(0);
    RegChangeCurrentDirectoryP(directory);
    return admitted;
}

EMSCRIPTEN_KEEPALIVE int WebNetDepartParticipant(u32 tick, s32 slot, u32 low, u32 high)
{
    if (!membership_boundary(tick) || GameInfo.deathmatch_finished || !WebNetSlotOccupied(slot))
        return 0;
    WebParticipantState participants;
    WebParticipantCapture(&participants);
    const WebParticipantId id = participants.slots[slot].id;
    if (id.low != low || id.high != high)
        return 0;
    WebCheckpointArenaSelect(WebLevelCheckpointActive());
    /* Ordinary object destruction resolves described weak references, capture
     * links and owned children while copied projectile provenance survives. */
    match.departing = 1;
    if (GameInfo.players[slot].car)
        ObjectDestroy(GameInfo.players[slot].car);
    match.departing = 0;
    if (GameInfo.active_view == GameInfo.players[slot].camera)
        GameInfo.active_view = NULL;
    if (GameInfo.players[slot].camera)
        ObjectDestroy(GameInfo.players[slot].camera);
    WebParticipantCapture(&participants);
    GameInfo.players[slot] = (Tm4GamePlayer) { 0 };
    PadJpad[slot] = (PadCache) { 0 };
    match.inputs[slot] = (NetPadInput) { 0 };
    participants.slots[slot] = (WebParticipantResult) { 0 };
    participants.respawns[slot] = (WebParticipantRespawn) { 0 };
    participants.models[slot] = 0;
    WebParticipantRestore(&participants);
    WebNetRestoreParticipantConfiguration();
    WebCheckpointArenaSelect(0);
    return 1;
}

/* All startup data is mandatory and validated in a local candidate. No prior
 * selection, failed request or cancelled match can contribute configuration. */
static int start_match(s32 capacity, u32 slots, s32 world, u32 seed, s32 view_slot, u32 flags,
    const char* car_names, const char* participant_ids, u32 respawn_delay_ticks,
    const char* pool_names, u32 time_limit_ticks, u32 frag_limit)
{
    if (WebNetMatchActive() || WebLevelActive() || capacity < 2 || capacity > 8 || !slots
        || (slots & ~((1u << capacity) - 1)) || __builtin_popcount(slots) < 2 || view_slot < -1
        || view_slot >= capacity || world < 0 || world >= GameGetNumberOfWorlds() || flags > 3
        || !car_names || ((flags & 2) && (view_slot < 0 || WebSimulationOnly())))
        return reject_start("Invalid explicit match configuration or session already running");
#ifndef TM4_STANDALONE
    if (flags && EM_ASM_INT({ return !!Module.tm4ResourceMods || !!Module.tm4CodeMods ?.size; }))
        return reject_start("Checkpoint mode is unavailable with resource or code mods");
#endif
    const size_t length = strnlen(car_names, 1024);
    if (!length || length >= 1024)
        return reject_start("Missing or oversized mode car roster");
    NetMatchSetup candidate = { .capacity = capacity,
        .slots = slots,
        .world = GameGetWorldName(world),
        .seed = seed,
        .view_slot = view_slot,
        .flags = flags,
        .respawn_delay_ticks = respawn_delay_ticks,
        .time_limit_ticks = time_limit_ticks,
        .frag_limit = frag_limit };
    const char* cursor = car_names;
    const s32 count = __builtin_popcount(slots);
    for (s32 car = 0; car < count; ++car) {
        const char* end = strchr(cursor, '\n');
        if (!end)
            end = car_names + length;
        if (end == cursor || (car == count - 1 ? *end != 0 : *end != '\n'))
            return reject_start("Mode car roster does not match occupied slots");
        const s32 available = RegGetNumberOfDirectoriesS("/objects/car/characters");
        for (s32 i = 0; i < available; ++i) {
            char* name = RegGetDirectoryNameSN("/objects/car/characters", i);
            if (name && strlen(name) == (size_t)(end - cursor)
                && !strncmp(name, cursor, end - cursor)) {
                candidate.cars[car] = name;
                break;
            }
        }
        if (!candidate.cars[car])
            return reject_start("Mode car is unavailable");
        cursor = end + 1;
    }
    WebParticipantState participants;
    if (!WebParticipantParse(&participants, slots, participant_ids))
        return reject_start("Invalid participant identities");
    if (pool_names) {
        const size_t pool_length = strnlen(pool_names, 512);
        if (!pool_length || pool_length >= 512)
            return reject_start("Invalid prepared model pool");
        const char* entry = pool_names;
        while (*entry) {
            const char* end = strchr(entry, '\n');
            if (!end)
                end = pool_names + pool_length;
            if (end == entry || end - entry >= 64 || candidate.model_count == 8)
                return reject_start("Invalid prepared model pool");
            char* model = NULL;
            const s32 available = RegGetNumberOfDirectoriesS("/objects/car/characters");
            for (s32 i = 0; i < available; ++i) {
                char* name = RegGetDirectoryNameSN("/objects/car/characters", i);
                if (name && strlen(name) == (size_t)(end - entry)
                    && !strncmp(name, entry, end - entry)) {
                    model = name;
                    break;
                }
            }
            if (!model)
                return reject_start("Prepared model is unavailable");
            for (u32 i = 0; i < candidate.model_count; ++i)
                if (!strcmp(candidate.model_pool[i], model))
                    return reject_start("Duplicate prepared model");
            candidate.model_pool[candidate.model_count++] = model;
            if (!*end)
                break;
            entry = end + 1;
            if (!*entry)
                return reject_start("Invalid prepared model pool");
        }
    } else {
        /* Diagnostic original-rule fixtures use only their declared roster. */
        for (s32 i = 0; i < count; ++i) {
            u32 j = 0;
            while (j < candidate.model_count && strcmp(candidate.model_pool[j], candidate.cars[i]))
                ++j;
            if (j == candidate.model_count)
                candidate.model_pool[candidate.model_count++] = candidate.cars[i];
        }
    }
    s32 entrant = 0;
    for (s32 slot = 0; slot < capacity; ++slot) {
        if (!(slots & (1u << slot)))
            continue;
        u32 i = 0;
        while (
            i < candidate.model_count && strcmp(candidate.model_pool[i], candidate.cars[entrant]))
            ++i;
        if (i == candidate.model_count)
            return reject_start("Initial car is outside prepared pool");
        participants.models[slot] = i + 1;
        ++entrant;
    }
    if (!session_resources_present(&candidate))
        return 0;
    match.setup = candidate;
    WebFfaRestore((WebFfaResult) { 0 });
    match.initial_participants = participants;
    WebParticipantRestore(&participants);
    match.tick = 0;
    WEB_BROWSER_REPORT({
        tm4Port.networkSynchronous = true;
        tm4Port.renderLimit = 30;
        tm4Port.renderSmoothing = false;
        globalThis.dispatchEvent ?.(new CustomEvent("tm4-network-mode", { detail : true }));
        tm4Port.netSession = ({ status : "loading" });
    });
    start_session();
    return 1;
}

/* Production network matches use FFA. The original driver remains available only
 * to diagnostic fixtures that verify the shared lifecycle independently of policy. */
EMSCRIPTEN_KEEPALIVE int WebNetStartFfa(s32 capacity, u32 slots, s32 world, u32 seed, s32 view_slot,
    u32 flags, const char* car_names, const char* participant_ids, u32 delay,
    const char* model_pool, u32 time_limit_ticks, u32 frag_limit)
{
    if (capacity != 8 || !delay || delay > 3600 || !model_pool
        || !time_limit_ticks || time_limit_ticks > 0x7fffffffu
        || !frag_limit || frag_limit > 0x7fffffffu)
        return reject_start("Invalid FFA respawn delay or gameplay capacity");
    return start_match(capacity, slots, world, seed, view_slot, flags, car_names, participant_ids,
        delay, model_pool, time_limit_ticks, frag_limit);
}

int WebNetDeparting(void)
{
    return match.departing;
}

u32 WebNetFfaTimeLimit(void)
{
    return match.setup.time_limit_ticks;
}

u32 WebNetFfaFragLimit(void)
{
    return match.setup.frag_limit;
}

u32 WebNetFfaRespawnDelay(void)
{
    return match.setup.respawn_delay_ticks;
}

#ifdef TM4_WEB_TEST_HOOKS
EMSCRIPTEN_KEEPALIVE int WebNetStartMatch(s32 capacity, u32 slots, s32 world, u32 seed,
    s32 view_slot, u32 flags, const char* car_names, const char* participant_ids)
{
    return start_match(
        capacity, slots, world, seed, view_slot, flags, car_names, participant_ids, 0, NULL, 0, 0);
}
#endif

static void start_session(void)
{
    WebParticipantRestore(&match.initial_participants);
    WebLeaveMenu();
    memset(&GameInfo, 0, sizeof(GameInfo));
    GameInitialize();
    WebResetNetworkCheats();
    GameInfo.player_count = 1;
    GameInfo.extra_player_count = __builtin_popcount(match.setup.slots) - 1;
    GameInfo.computer_count = 0;
    GameInfo.ally_count = 0;
    GameInfo.pause_player = 0;
    GameInfo.intro_character = NULL;
    GameInfo.world_name = match.setup.world;
    GameInfo.game_type = GAME_TYPE_DEATHMATCH;
    GameInfo.deathmatch_world_selection = DEATHMATCH_WORLD_REPEAT;
    GameInfo.deathmatch_car_selection = DEATHMATCH_OPPONENTS_PLAYER_CHOSEN;
    GameInfo.deathmatch_limit_is_wins = 0;
    GameInfo.deathmatch_limit = 1;
    GameInfo.view_layouts[0] = 0;
    for (s32 slot = 0; slot < __builtin_popcount(match.setup.slots); ++slot) {
        GameInfo.character_names[slot] = match.setup.cars[slot];
        GameSetControllerConfigDefault(&GameInfo, WebNetParticipantSlot(slot), 0);
        GameSetControllerConfigDefault(&GameInfo, WebNetParticipantSlot(slot), 1);
    }
    GameInfo.next_mode = GAME_MODE_PLAY;
    WebParticipantState participants;
    WebParticipantCapture(&participants);
    for (s32 slot = 0; slot < 8; ++slot) {
        participants.slots[slot].frags = 0;
        participants.slots[slot].deaths = 0;
        participants.respawns[slot] = (WebParticipantRespawn) { 0 };
    }
    WebParticipantRestore(&participants);
    WebLevelStart();
    match.physical_pad = (PadCache) { 0 };
    memset(PadJpad, 0, sizeof(PadJpad));
    WEB_BROWSER_REPORT(
        {
            tm4Port.netSession = ({ status : "ready" });
            tm4Port.netMatch = ({ capacity : $0, tick : 0, status : "ready" });
        },
        match.setup.capacity);
    WebNetMatchPublishTick();
}

static const char* checkpoint_resource_blocker(void)
{
/* The standalone boundary supplies stock local resources and has no JS mod loader. */
#ifndef TM4_STANDALONE
    if (EM_ASM_INT({ return !!Module.tm4CodeMods ?.size; }))
        return "independent module state";
#endif
    if (GameInfo.game_type != GAME_TYPE_DEATHMATCH || GameInfo.computer_count != 0)
        return "game mode state";
    return NULL;
}

int WebNetRenderedPrediction(void)
{
    return WebNetMatchActive() && (match.setup.flags & 2) && match.setup.view_slot >= 0;
}
int WebNetPortableCheckpointEnabled(void)
{
    return WebNetMatchActive() && (match.setup.flags & 1);
}

int WebNetLocalCheckpointSupported(void)
{
#ifdef TM4_STANDALONE
    const int host_checkpoint = 1;
#else
    const int host_checkpoint
        = EM_ASM_INT({ return Module.tm4LocalCheckpoint && !Module.tm4ResourceMods; });
#endif
    return match.setup.capacity && !checkpoint_resource_blocker()
        && (WebNetRenderedPrediction()
            || (match.setup.view_slot < 0 && WebSimulationOnly()
                && (WebNetPortableCheckpointEnabled() || host_checkpoint)));
}

static int local_checkpoint_boundary(void)
{
    return WebNetLocalCheckpointSupported() && WebLevelCheckpointActive() && WebLevelActive()
        && !match.replaying && !match.stepping && !match.tick_pending && !match.input_mask;
}

static int local_checkpoint_error(const char* message)
{
    WEB_BROWSER_REPORT({ tm4Port.localCheckpointError = $0 ? UTF8ToString($0) : null; }, message);
    return 0;
}

EMSCRIPTEN_KEEPALIVE u32 WebNetCaptureLocalCheckpoint(void)
{
    if (!local_checkpoint_boundary() || match.local_replaying)
        return local_checkpoint_error("capture requires a supported match at a live tick boundary");
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
        return local_checkpoint_error(
            "checkpoint capture tick does not match the simulation boundary");
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
        return local_checkpoint_error("restore requires a supported match at a tick boundary");
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

const char* WebNetCapturePortableInto(u8* output, u32 capacity, u32* length)
{
    *length = 0;
    if (!WebNetPortableCheckpointEnabled() || !local_checkpoint_boundary() || match.local_replaying)
        return "portable capture requires a supported live tick boundary";
    const char* blocker = NULL;
    *length = WebSnapshotCapture(output, capacity, &blocker);
    return *length ? NULL : blocker ? blocker : "portable capture rejected";
}

const char* WebNetRestorePortableFrom(const u8* input, u32 length)
{
    if (!WebNetPortableCheckpointEnabled() || !local_checkpoint_boundary() || match.tick
        || match.local_replaying)
        return "portable restore requires a fresh supported match";
    const char* blocker = NULL;
    if (!WebSnapshotRestore(input, length, &blocker))
        return blocker ? blocker : "portable restore rejected";
    match.tick = MainFrameCount;
    match.replaying = 1;
    WebNetMatchPublishTick();
    return NULL;
}

EMSCRIPTEN_KEEPALIVE u32 WebNetCapturePortableCheckpoint(void)
{
    if (!WebNetPortableCheckpointEnabled() || !local_checkpoint_boundary() || match.local_replaying)
        return 0;
    u8* bytes = malloc(WebSnapshotMaxBytes);
    if (!bytes)
        return 0;
    const char* blocker = NULL;
    u32 length = 0;
    blocker = WebNetCapturePortableInto(bytes, WebSnapshotMaxBytes, &length);
    EM_ASM(
        {
            tm4Port.portableCheckpointError = $2 ? UTF8ToString($2) : null;
            if ($1)
                tm4Port.portableCheckpoint = HEAPU8.slice($0, $0 + $1);
            else
                delete tm4Port.portableCheckpoint;
        },
        bytes, length, blocker);
    free(bytes);
    return length;
}

EMSCRIPTEN_KEEPALIVE int WebNetBeginPortableReplay(void)
{
    if (!WebNetPortableCheckpointEnabled() || !local_checkpoint_boundary() || match.tick
        || match.local_replaying)
        return 0;
    const u32 length = EM_ASM_INT(
        { return (tm4Port.portableCheckpoint && tm4Port.portableCheckpoint.length) || 0; });
    if (!length || length > WebSnapshotMaxBytes)
        return 0;
    u8* bytes = malloc(length);
    if (!bytes)
        return 0;
    EM_ASM({ HEAPU8.set(tm4Port.portableCheckpoint, $0); }, bytes);
    const char* blocker = WebNetRestorePortableFrom(bytes, length);
    free(bytes);
    EM_ASM({ tm4Port.portableCheckpointError = $0 ? UTF8ToString($0) : null; }, blocker);
    return blocker == NULL;
}

int WebNetReplaying(void)
{
    return match.replaying || match.local_replaying;
}

#ifdef TM4_WEB_TEST_HOOKS
EMSCRIPTEN_KEEPALIVE int WebTestRestartNetworkReplay(void)
{
    if (!WebNetMatchActive() || !WebLevelActive() || WebNetReplaying() || match.stepping
        || match.tick_pending || match.input_mask || checkpoint_resource_blocker())
        return 0;

    RegistryDirectory* directory = RegGetCurrentDirectoryPtr();
    int resources_present = session_resources_present(&match.setup);
    RegChangeCurrentDirectoryP(directory);
    if (!resources_present)
        return 0;

    match.replaying = 1;
    WebLevelStop();
    match.tick = 0;
    start_session();
    return 1;
}
#endif

EMSCRIPTEN_KEEPALIVE void WebNetEndReplay(void)
{
    if (match.replaying)
        WebNetSuppressReplayedSounds();
    match.replaying = 0;
}

int WebNetMatchActive(void)
{
    return match.setup.capacity != 0;
}

EMSCRIPTEN_KEEPALIVE void WebNetCancelMatch(void)
{
    if (match.setup.capacity) {
        WebLevelStop();
        WebNetMatchEnd();
    }
}

int WebNetLocalViewCount(void)
{
    return WebNetMatchActive()
        ? (match.setup.view_slot >= 0 && WebNetSlotOccupied(match.setup.view_slot)
              && GameInfo.players[match.setup.view_slot].camera != NULL)
        : GameInfo.player_count;
}

int WebNetGameplaySlot(int view)
{
    return WebNetMatchActive() ? match.setup.view_slot : view;
}

int WebNetLocalView(int slot)
{
    return WebNetMatchActive() ? (slot == match.setup.view_slot ? 0 : -1) : slot;
}

int WebNetMatchViewSlot(void)
{
    return match.setup.view_slot;
}

void WebNetMatchPollInput(void)
{
    if (match.setup.view_slot < 0)
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
        GameInfo.random_seed = match.setup.seed;
        srand(match.setup.seed);
        srandrand(match.setup.seed);
    }
}

EMSCRIPTEN_KEEPALIVE int WebNetSetInput(u32 tick, s32 slot, u32 buttons, u32 axes, s32 analog)
{
    if (!WebNetMatchActive() || !WebLevelActive() || tick != match.tick || match.stepping
        || match.tick_pending || !WebNetSlotOccupied(slot) || buttons > 0xffff
        || (analog != 0 && analog != 1))
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
        || match.tick_pending || match.input_mask != (u32)WebNetSlotMask())
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

    for (s32 slot = 0; slot < 8; ++slot) {
        if (!WebNetSlotOccupied(slot))
            continue;
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
    WEB_BROWSER_REPORT(
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
        GameInfo.deathmatch_finished, GameInfo.deathmatch_accept_input, GameInfo.next_mode, digest,
        state.session, state.cars, state.objects, state.world, state.sound, unsupported);
    const WebFfaResult result = WebFfaCapture();
    WEB_BROWSER_REPORT({ tm4Port.netMatch.completion = ({ tick : $0, reasons : $1, winners : $2 }); },
        result.tick, result.reasons, result.winners);
    WebParticipantState participants;
    WebParticipantCapture(&participants);
    if (match.setup.view_slot >= 0) {
        const WebParticipantRespawn* respawn = &participants.respawns[match.setup.view_slot];
        WEB_BROWSER_REPORT(
            { tm4Port.netMatch.respawn = ({ state : $0, dueTick : $1 }); }, respawn->state,
            respawn->due_tick);
    }
    for (s32 slot = 0; slot < match.setup.capacity; ++slot) {
        WEB_BROWSER_REPORT(
            { tm4Port.netMatch.scores.push({ frags : $0, deaths : $1 }); },
            participants.slots[slot].frags, participants.slots[slot].deaths);
    }
#if defined(TM4_WEB_TEST_HOOKS) && !defined(TM4_STANDALONE)
    if (match.tick && !WebNetReplaying())
        EM_ASM({ tm4Port.testSimulationTick ?.(); });

#endif
}

void WebNetMatchEnd(void)
{
    memset(&match, 0, sizeof(match));
    WebFfaRestore((WebFfaResult) { 0 });
    const WebParticipantState empty = { 0 };
    WebParticipantRestore(&empty);
    WEB_BROWSER_REPORT({
        delete tm4Port.netMatch;
        delete tm4Port.netCapturedState;
        delete tm4Port.localCheckpointError;
        tm4Port.networkSynchronous = false;
        globalThis.dispatchEvent ?.(new CustomEvent("tm4-network-mode", { detail : false }));
    });
}
