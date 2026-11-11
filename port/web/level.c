#include <libgte.h>
#include "level.h"
#include "car.h"
#include "checkpoint.h"
#include "checkpoint_memory.h"
#include "interpolation.h"
#include "loading.h"
#include "movie.h"
#include "net_match.h"
#include "render_sync.h"
#include "rollback_audio.h"
#include "snapshot_world.h"
#include "tm4/main/carresources.h"
#include "tm4/main/cd.h"
#include "tm4/main/game.h"
#include "tm4/main/image.h"
#include "tm4/main/loadfiles.h"
#include "tm4/main/main.h"
#include "tm4/main/memory.h"
#include "tm4/main/object.h"
#include "tm4/main/pad.h"
#include "tm4/main/pause.h"
#include "tm4/main/redbook.h"
#include "tm4/main/registry.h"
#include "tm4/main/render.h"
#include "tm4/main/screen.h"
#include "tm4/main/sound.h"
#include "tm4/main/system.h"
#ifdef TM4_WEB_TEST_HOOKS
#include "tm4/main/tournament.h"
#endif
#include "tm4/main/world.h"
#include "tm4/modules/camera.h"
#include <assert.h>
#include "port/web/browser_report.h"
#include <libetc.h>
#include <libgpu.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef TM4_WEB_TEST_HOOKS
void WebTestApplyPendingActions(void);
void WebTestMotionInput(void);
#endif

/* Browser frame loop for the recovered game session and world renderer. */
static int active;
static int checkpoint_arena;
static unsigned int frames;
static unsigned int simulation_steps;
static double last_step;
static WebRenderMotionSettings motion;
static int demo_draw_enabled;
static int network_frame_pending;

EMSCRIPTEN_KEEPALIVE unsigned int WebGetSimulationSteps(void)
{
    return simulation_steps;
}

static void* require_resource(char* path)
{
    void* value = RegGetFileDataS(path);
    if (!value) {
        fprintf(stderr, "Missing level resource: %s\n", path);
        abort();
    }
    return value;
}

static void restore_music_volume(s32 index)
{
    SystemRestoreMusicVolume();
}

void WebLevelStart(void)
{
    if (active)
        return;
    if (GameInfo.intro_character) {
        WebMovieEnding(WebLevelStart);
        return;
    }
    CarResourcesPrepare();
    GamePrepareSession();
#if defined(TM4_WEB_TEST_HOOKS) && !defined(TM4_STANDALONE)
    u32 motion_seed = EM_ASM_INT({ return tm4Port.testMotionSeed || 0; });
    if (motion_seed && GameInfo.game_type == GAME_TYPE_TOURNAMENT) {
        /* GamePrepareSession selects the normal roster before the replay supplies its seed. */
        GameInfo.random_seed = motion_seed;
        srand(motion_seed);
        srandrand(motion_seed);
        TournamentReset(&GameInfo, 1);
    }
#endif
    RegistryDirectory* metadata = GameGetWorldNameDirectoryPtr(GameInfo.world_name);
    const char* filename = RegGetFileDataPS(metadata, "filename");
    if (!filename) {
        fprintf(stderr, "Unknown selected world: %s\n", GameInfo.world_name);
        abort();
    }
    printf("Loading %s (%s)...\n", GameInfo.world_name, filename);
    char background[32];
    int background_length = snprintf(background, sizeof(background), "%s.TIM", filename);
    assert(background_length > 0 && background_length < sizeof(background));
    if (!WebNetMatchActive())
        WebLoadingBackground(background);
    GameInfo.mode = GameInfo.next_mode;
    GameInfo.next_mode = 0;
    LoadGameFiles();
    s32 squares = *(s32*)require_resource("/world/squares/numSquares");
    s32 faces = *(s32*)require_resource("/world/displayPolys/numWorldFaces");
    s32 vertices = *(s32*)require_resource("/world/displayPolys/numWorldVertices");
    s32 collision_faces = *(s32*)require_resource("/world/collisionPolys/numCollideInList");
    Tm4GameSpawnPoint* start = require_resource("/world/startpoints");
    assert(WorldFindSquare(start->position.vx, start->position.vz));
    InitGeom();
    SoundSetSoundMasterVolume(GameInfo.sound_volume);
    WebCarEnable();
    ObjectConstructor();
    checkpoint_arena = WebNetLocalCheckpointSupported() && WebCheckpointArenaOpen();
    WebCheckpointArenaSelect(checkpoint_arena);
    s32 camera_count
        = GameInfo.player_count + (WebNetMatchActive() ? GameInfo.extra_player_count : 0);
    for (s32 i = 0; i < ArrayCount(GameInfo.players); ++i) {
        GameInfo.players[i].camera = i < camera_count ? ObjectCreate("camera", 0, NULL) : NULL;
        assert(i >= camera_count || GameInfo.players[i].camera);
    }
    WEB_BROWSER_REPORT({ tm4Port.cameraSlots = []; });
    for (s32 i = 0; i < ArrayCount(GameInfo.players); ++i)
        WEB_BROWSER_REPORT({ tm4Port.cameraSlots.push(!!$0); }, GameInfo.players[i].camera);
    ObjectStartupInstance();
    WebCheckpointArenaSelect(0);
    SoundSetMusicVolume(GameInfo.music_volume);
    if (!WebSimulationOnly())
        RedbookMusic(1, restore_music_volume, *(s32*)RegGetFileDataPS(metadata, "musicTrackNum"));
    SoundStopSounds();
    RenderConstructor();
    ScreenInitialize();
    if (WebNetMatchActive() && WebNetMatchViewSlot() >= 0)
        SetDispMask(1);
    WebCheckpointArenaSelect(checkpoint_arena);
    WebCarStart();
    WebCheckpointArenaSelect(0);
    if (!WebNetMatchActive()) {
        PadGetPad(8);
        PadGetPad(8);
        PadGetPad(8);
    }
    for (s32 i = 0; i < GameInfo.player_count; ++i)
        MainControllerTypes[i] = PadJpad[i].port_id;
    MainFrameCount = 0;
    PadResetVibration();
    PadInitVibrationDirectory();
    for (s32 i = 0; !checkpoint_arena && i < GameInfo.player_count; ++i)
        PadSetVibrationEnabled(
            i, GameInfo.mode == GAME_MODE_PLAY && GameInfo.players[i].vibration_enabled);
    frames = 0;
    network_frame_pending = 0;
    motion = (WebRenderMotionSettings){ 0 };
    WebInterpolationReset();
    if (WebNetRenderedPrediction())
        WebRollbackAudioReset();
    demo_draw_enabled = 1;
#ifndef TM4_STANDALONE
    last_step = emscripten_get_now();
#endif
    WebRenderResetTiming();
    if (WebNetPortableCheckpointEnabled() && checkpoint_arena)
        WebSnapshotWorldOpen();
    WEB_BROWSER_REPORT({ tm4Port.renderPhaseCounts = ([ 0, 0, 0 ]); });
    active = 1;
    printf("%s initialized: %d cells, %d vertices, %d faces, %d collision faces; spawn %d,%d,%d\n",
        GameInfo.world_name, squares, vertices, faces, collision_faces, start->position.vx,
        start->position.vy, start->position.vz);
    WEB_BROWSER_REPORT(
        {
            Object.assign(globalThis.tm4Port, {
                screen : 'level',
                level : UTF8ToString($4),
                squares : $0,
                vertices : $1,
                faces : $2,
                collisionFaces : $3,
                levelFrames : 0,
                renderSmoothing : false,
                renderSmoothingLead : 0,
                simulationTicks : 0,
                demoFrozen : false,
                demoDrawEnabled : true
            });
        },
        squares, vertices, faces, collision_faces, GameInfo.world_name);
}

int WebLevelActive(void)
{
    return active;
}

int WebLevelCheckpointActive(void)
{
    return checkpoint_arena;
}

void WebLevelStop(void)
{
    WebCheckpointDiscard();
    WebSnapshotWorldClose();
    WebInterpolationReset();
    PadStopPad();
    RedbookPause();
    SoundStopSounds();
    WebCheckpointArenaSelect(checkpoint_arena);
    ObjectDestructor();
    WebCheckpointArenaSelect(0);
    RenderDestructor();
    RegRemoveReg("cars");
    RegRemoveReg("game");
    RegRemoveReg("world");
    WorldSquares = NULL;
    WorldCells = NULL;
    SoundDestructor();
    CarResourcesExtractAll();
    if (checkpoint_arena)
        WebCheckpointArenaClose();
    checkpoint_arena = 0;
    active = 0;
}

static void finish_session(void)
{
    WebLevelStop();
    if (WebDirectStartup())
        return;
    if (GameInfo.save_menu || GameInfo.next_mode == GAME_MODE_MENU)
        WebReturnToMenu();
    else
        WebLevelStart();
}

u32 WebCheckpointGteCapture(void* output, u32 capacity);
void WebCheckpointGteRestore(const void* input);
void WebScreenBeginPredictedTick(u32 tick);
void WebScreenFinishPredictedTick(void);

static void process_level_step(void)
{
#ifdef TM4_WEB_TEST_HOOKS
    WebTestApplyPendingActions();
#ifndef TM4_STANDALONE
    WebTestMotionInput();
#endif
#endif
    WebCarStep();
    ++simulation_steps;
    if (WebSimulationOnly())
        return;
    if (checkpoint_arena && WebNetRenderedPrediction()) {
        u8 gte[256];
        if (!WebNetReplaying() && WebCheckpointGteCapture(gte, sizeof(gte))) {
            WebCheckpointArenaSelect(0);
            SoundProcess();
            WorldAnimateTextures();
            ScreenProcess();
            WebCheckpointGteRestore(gte);
            WebCheckpointArenaSelect(1);
        }
    } else {
        SoundProcess();
        if (!checkpoint_arena) {
            WorldAnimateTextures();
            ScreenProcess();
        }
    }
}

static void present_level_frame(Tm4RenderBuffer* buffer, double phase)
{
    if (GameInfo.mode != GAME_MODE_DEMO)
        WebInterpolationBeginDraw(motion, phase);
    RenderBuildFrame();
    WebInterpolationEndDraw();
    WebRenderPresentLevelFrame();
    ++frames;
    WEB_BROWSER_REPORT(
        { tm4Port.hudGlyphs = $0; }, buffer->font_prims.next_sprite - buffer->font_prims.sprites);
    WEB_BROWSER_REPORT(
        { Object.assign(tm4Port, { levelFrames : $0, cameraX : $1, cameraY : $2, cameraZ : $3 }); },
        frames, GameInfo.players[0].camera->camera_to_world.t[0],
        GameInfo.players[0].camera->camera_to_world.t[1],
        GameInfo.players[0].camera->camera_to_world.t[2]);
}

/* Attract-mode controls change the original loop's VBlank pacing, not gameplay rules. */
static void demo_frame(void)
{
    Tm4RenderBuffer* buffer = demo_draw_enabled ? RenderBeginFrame() : RenderGetDrawBuffer();
    PadGetPad(4);
    if ((PadJpad[0].pressed_buttons & PADstart) || PadJpad[0].idle_ticks >= 1800
        || !GameInfo.car_count) {
        PadJpad[0].idle_ticks = 0;
        PadJpad[0].pressed_buttons &= ~PADstart;
        GameInfo.next_mode = GAME_MODE_MENU;
        finish_session();
        return;
    }
    process_level_step();
    if (demo_draw_enabled)
        present_level_frame(buffer, 1);
    else
        VSync(0);

    int toggle = 0;
    for (s32 i = 0; i < GameInfo.player_count; ++i) {
        PadCache* controller = &PadJpad[i];
        if (controller->buttons & PADLleft) {
            VSync(0);
            VSync(0);
            VSync(0);
        }
        if (controller->buttons & PADLright)
            toggle = 1;
        if (controller->buttons & PADLdown) {
            SoundStopSounds();
            WEB_BROWSER_REPORT({ tm4Port.demoFrozen = true; });
            do {
                VSync(0);
                PadGetPad(8);
                VSync(0);
            } while (PadJpad[i].buttons & PADLdown);
            WEB_BROWSER_REPORT({ tm4Port.demoFrozen = false; });
        }
    }
    demo_draw_enabled = toggle ? !demo_draw_enabled : 1;
    GameProcessMode();
    ++MainFrameCount;
    WEB_BROWSER_REPORT(
        {
            tm4Port.simulationTicks = $0;
            tm4Port.demoDrawEnabled = !!$1;
        },
        MainFrameCount, demo_draw_enabled);
    if (GameInfo.next_mode)
        finish_session();
}

static void draw_network_view(s32 slot)
{
    u8 gte[256];
    Camera* active_view = GameInfo.active_view;
    int saved_gte = WebNetRenderedPrediction();
    if (saved_gte && !WebCheckpointGteCapture(gte, sizeof(gte)))
        return;
    const Tm4GamePlayer* player = &GameInfo.players[slot];
    /* Turbo effects draw from the secondary RNG between simulation ticks. */
    const u32 effect_seed = WebRenderEffectRandomState();
    RenderBeginFrame();
    RenderBuildFrame();
    srandrand(effect_seed);
    WebRenderPresentLevelFrame();
    if (saved_gte) {
        WebCheckpointGteRestore(gte);
        GameInfo.active_view = active_view;
    }
    ++frames;
    WEB_BROWSER_REPORT(
        {
            Object.assign(
                tm4Port, { levelFrames : $0, netViewSlot : $1, netCameraAttached : !!$2 });
        },
        frames, slot, player->camera->object != NULL);
}

void WebLevelNetworkStep(void)
{
    if (!active || !WebNetMatchTakeInput())
        return;
    int rendered = WebNetRenderedPrediction();
    if (rendered)
        WebScreenBeginPredictedTick((u32)MainFrameCount + 1);
    WebCheckpointArenaSelect(checkpoint_arena);
    process_level_step();
    GameProcessMode();
    WebCheckpointArenaSelect(0);
    if (rendered)
        WebScreenFinishPredictedTick();
    network_frame_pending = 1;
    ++MainFrameCount;
    WEB_BROWSER_REPORT({ tm4Port.simulationTicks = $0; }, MainFrameCount);
    WebNetMatchPublishTick();
}

void WebLevelFrame(void)
{
    if (WebNetMatchActive()) {
        if (WebNetReplaying())
            return;
        WebNetMatchPollInput();
        if (WebNetMatchViewSlot() >= 0 && network_frame_pending && WebRenderBeginLevelFrame()) {
            network_frame_pending = 0;
            draw_network_view(WebNetMatchViewSlot());
        }
        return;
    }
    if (GameInfo.mode == GAME_MODE_DEMO) {
        demo_frame();
        return;
    }
    if (!WebRenderBeginLevelFrame())
        return;
    const double step_ms = WEB_SIMULATION_STEP_MS;
    /* Three and four views use two successive render passes and reuse packet storage. */
    WebRenderMotionSettings selected
        = GameInfo.player_count <= 2 ? WebRenderGetMotionSettings() : (WebRenderMotionSettings){ 0 };
    int capture = selected.enabled;
    if (motion.enabled != selected.enabled || motion.lead != selected.lead) {
        if (motion.enabled != selected.enabled)
            WebRenderResetTiming();
        motion = selected;
        WebInterpolationReset();
        WEB_BROWSER_REPORT(
            {
                tm4Port.renderSmoothing = !!$0;
                tm4Port.renderSmoothingLead = $1;
            },
            motion.enabled, motion.lead);
        capture = 0;
    }
    double now = emscripten_get_now();
    if (!last_step)
        last_step = now;
    Tm4RenderBuffer* buffer = RenderBeginFrame();
    int catchup = 0;
    /* A stalled callback can run catch-up ticks, but its first draw uses live poses. */
    if (now - last_step >= step_ms * 5) {
        WebInterpolationReset();
        capture = 0;
    }
    while (now - last_step >= step_ms && catchup++ < 5) {
        PadGetPad(4);
        if (GameInfo.mode == GAME_MODE_PLAY) {
            for (s32 i = 0; i < GameInfo.player_count; ++i) {
                PadCache* controller = &PadJpad[i];
                if ((controller->pressed_buttons & PADstart) || controller->port_id == -1
                    || MainControllerTypes[i] != controller->port_id
                    || controller->absent_ticks >= 10) {
                    GameInfo.pause_player = i + 1;
                    break;
                }
            }
        }
        if (GameInfo.pause_player) {
            WEB_BROWSER_REPORT(
                {
                    tm4Port.paused = true;
                    tm4Port.pausePlayer = $0;
                },
                GameInfo.pause_player);
            WebInterpolationReset();
            s32 result = PauseMenu(&buffer, GameInfo.pause_player - 1, 0);
            GameInfo.pause_player = 0;
            WebRenderResetTiming();
            WEB_BROWSER_REPORT({ tm4Port.paused = false; });
            now = emscripten_get_now();
            last_step = now - step_ms;
            /* The first resumed draw should use the current pose. */
            capture = 0;
            if (result == PAUSE_RESULT_QUIT) {
                GameInfo.next_mode = GAME_MODE_MENU;
                finish_session();
                return;
            }
        }
        if (capture)
            WebInterpolationBeginStep();
        process_level_step();
        GameProcessMode();
        if (capture)
            WebInterpolationFinishStep(motion.lead);
        ++MainFrameCount;
#ifdef TM4_WEB_TEST_HOOKS
        WEB_BROWSER_REPORT(
            {
                tm4Port.testMotionSimulation?.push([
                    $0, $1, tm4Port.cars, tm4Port.weaponAmmo, tm4Port.carSelectedWeapon
                ]);
            },
            MainFrameCount, randseed());
#endif
        last_step += step_ms;
        if (GameInfo.next_mode)
            break;
    }
    if (now - last_step > step_ms * 5) {
        last_step = now;
        WebInterpolationReset();
    }
    WEB_BROWSER_REPORT({ tm4Port.simulationTicks = $0; }, MainFrameCount);
    present_level_frame(buffer, (now - last_step) / step_ms);
    if (GameInfo.next_mode)
        finish_session();
}

#ifdef TM4_WEB_TEST_HOOKS
/* Exercise ending handoff after a live session; this does not simulate victory. */
EMSCRIPTEN_KEEPALIVE int WebTestEndingHandoff(void)
{
    if (!active)
        return 0;
    GameInfo.intro_character = GameInfo.character_names[0];
    GameInfo.next_mode = GAME_MODE_PLAY;
    return 1;
}
#endif
