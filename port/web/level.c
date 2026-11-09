#include <libgte.h>
#include "level.h"
#include "car.h"
#include "interpolation.h"
#include "loading.h"
#include "movie.h"
#include "render_sync.h"
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
#include "tm4/main/world.h"
#include "tm4/modules/camera.h"
#include <assert.h>
#include <emscripten.h>
#include <libetc.h>
#include <libgpu.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef TM4_WEB_TEST_HOOKS
void WebTestApplyPendingActions(void);
#endif

/* Browser frame loop for the recovered game session and world renderer. */
static int active;
static unsigned int frames;
static unsigned int simulation_steps;
static double last_step;
static int interpolating;
static int demo_draw_enabled;

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
    for (s32 i = 0; i < ArrayCount(GameInfo.players); ++i) {
        GameInfo.players[i].camera
            = i < GameInfo.player_count ? ObjectCreate("camera", 0, NULL) : NULL;
        assert(i >= GameInfo.player_count || GameInfo.players[i].camera);
    }
    EM_ASM({ tm4Port.cameraSlots = []; });
    for (s32 i = 0; i < ArrayCount(GameInfo.players); ++i)
        EM_ASM({ tm4Port.cameraSlots.push(!!$0); }, GameInfo.players[i].camera);
    ObjectStartupInstance();
    SoundSetMusicVolume(GameInfo.music_volume);
    RedbookMusic(1, restore_music_volume, *(s32*)RegGetFileDataPS(metadata, "musicTrackNum"));
    SoundStopSounds();
    RenderConstructor();
    ScreenInitialize();
    WebCarStart();
    PadGetPad(8);
    PadGetPad(8);
    PadGetPad(8);
    for (s32 i = 0; i < GameInfo.player_count; ++i)
        MainControllerTypes[i] = PadJpad[i].port_id;
    MainFrameCount = 0;
    PadResetVibration();
    PadInitVibrationDirectory();
    for (s32 i = 0; i < GameInfo.player_count; ++i)
        PadSetVibrationEnabled(
            i, GameInfo.mode == GAME_MODE_PLAY && GameInfo.players[i].vibration_enabled);
    frames = 0;
    interpolating = 0;
    WebInterpolationReset();
    demo_draw_enabled = 1;
    last_step = emscripten_get_now();
    WebRenderResetTiming();
    EM_ASM({ tm4Port.renderPhaseCounts = ([ 0, 0, 0 ]); });
    active = 1;
    printf("%s initialized: %d cells, %d vertices, %d faces, %d collision faces; spawn %d,%d,%d\n",
        GameInfo.world_name, squares, vertices, faces, collision_faces, start->position.vx,
        start->position.vy, start->position.vz);
    EM_ASM(
        {
            Object.assign(globalThis.tm4Port, {
                screen : 'level',
                level : UTF8ToString($4),
                squares : $0,
                vertices : $1,
                faces : $2,
                collisionFaces : $3,
                levelFrames : 0,
                interpolateMotion : false,
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

static void finish_session(void)
{
    WebInterpolationReset();
    PadStopPad();
    RedbookPause();
    SoundStopSounds();
    ObjectDestructor();
    RenderDestructor();
    RegRemoveReg("cars");
    RegRemoveReg("game");
    RegRemoveReg("world");
    WorldSquares = NULL;
    WorldCells = NULL;
    SoundDestructor();
    CarResourcesExtractAll();
    active = 0;
    if (GameInfo.save_menu || GameInfo.next_mode == GAME_MODE_MENU)
        WebReturnToMenu();
    else
        WebLevelStart();
}

static void process_level_step(void)
{
#ifdef TM4_WEB_TEST_HOOKS
    WebTestApplyPendingActions();
#endif
    WebCarStep();
    SoundProcess();
    WorldAnimateTextures();
    ScreenProcess();
    ++simulation_steps;
}

static void present_level_frame(Tm4RenderBuffer* buffer, double fraction, int stepped)
{
    if (interpolating)
        WebInterpolationBeginDraw(fraction, stepped);
    RenderBuildFrame();
    WebInterpolationEndDraw();
    WebRenderPresentLevelFrame(interpolating);
    ++frames;
    EM_ASM(
        { tm4Port.hudGlyphs = $0; }, buffer->font_prims.next_sprite - buffer->font_prims.sprites);
    EM_ASM(
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
        present_level_frame(buffer, 1, 1);
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
            EM_ASM({ tm4Port.demoFrozen = true; });
            do {
                VSync(0);
                PadGetPad(8);
                VSync(0);
            } while (PadJpad[i].buttons & PADLdown);
            EM_ASM({ tm4Port.demoFrozen = false; });
        }
    }
    demo_draw_enabled = toggle ? !demo_draw_enabled : 1;
    GameProcessMode();
    ++MainFrameCount;
    EM_ASM(
        {
            tm4Port.simulationTicks = $0;
            tm4Port.demoDrawEnabled = !!$1;
        },
        MainFrameCount, demo_draw_enabled);
    if (GameInfo.next_mode)
        finish_session();
}

void WebLevelFrame(void)
{
    if (GameInfo.mode == GAME_MODE_DEMO) {
        demo_frame();
        return;
    }
    const double step_ms = 1000.0 / 30;
    /* Three and four views use two successive render passes and reuse packet storage. */
    int interpolate = WebInterpolationEnabled() && GameInfo.player_count <= 2;
    if (interpolating != interpolate) {
        interpolating = interpolate;
        WebInterpolationReset();
        WebRenderResetTiming();
        EM_ASM({ tm4Port.interpolateMotion = !!$0; }, interpolating);
    }
    double now = emscripten_get_now();
    if (!last_step)
        last_step = now;
    Tm4RenderBuffer* buffer = RenderBeginFrame();
    int catchup = 0;
    int stepped = 0;
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
            EM_ASM(
                {
                    tm4Port.paused = true;
                    tm4Port.pausePlayer = $0;
                },
                GameInfo.pause_player);
            WebInterpolationReset();
            s32 result = PauseMenu(&buffer, GameInfo.pause_player - 1, 0);
            GameInfo.pause_player = 0;
            WebRenderResetTiming();
            EM_ASM({ tm4Port.paused = false; });
            now = emscripten_get_now();
            last_step = now - step_ms;
            /* The first resumed draw should use the current pose. */
            interpolate = 0;
            if (result == PAUSE_RESULT_QUIT) {
                GameInfo.next_mode = GAME_MODE_MENU;
                finish_session();
                return;
            }
        }
        if (interpolate)
            WebInterpolationBeginStep();
        process_level_step();
        GameProcessMode();
        if (interpolate)
            WebInterpolationFinishStep();
        stepped = 1;
        ++MainFrameCount;
        last_step += step_ms;
        if (GameInfo.next_mode)
            break;
    }
    if (now - last_step > step_ms * 5) {
        last_step = now;
        WebInterpolationReset();
    }
    EM_ASM({ tm4Port.simulationTicks = $0; }, MainFrameCount);
    present_level_frame(buffer, (now - last_step) / step_ms, stepped);
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
