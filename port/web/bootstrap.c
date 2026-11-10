#include <libgte.h>
#include "car.h"
#include "cheats.h"
#include "loading.h"
#include "movie.h"
#include "music.h"
#include "net_match.h"
#include "overlays.h"
#include "render_sync.h"
#include "subpixel.h"
#ifdef TM4_WEB_TEST_HOOKS
#include "test_hooks.h"
#endif
#include "tm4/main/redbook.h"
#include <libetc.h>
#include <libgpu.h>
#include <psyz.h>
#include <psyz/audio.h>
#include <psyz/overlay.h>
#include <psyz/video.h>

#include "src/modules/menu/private.h"
#include "tm4/main/cd.h"
#include "tm4/main/font.h"
#include "tm4/main/game.h"
#include "tm4/main/image.h"
#include "tm4/main/loading.h"
#include "tm4/main/memory.h"
#include "tm4/main/object.h"
#include "tm4/main/pad.h"
#include "tm4/main/registry.h"
#include "tm4/main/sound.h"
#include "tm4/main/system.h"

#include "level.h"
#include <emscripten.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

_Static_assert(sizeof(void*) == 4 && sizeof(long) == 4, "TM4 currently requires wasm32");

static uint64_t heap[32 * 1024 * 1024 / sizeof(uint64_t)];
static unsigned int directory_count;
static unsigned int resource_count;
static unsigned int frame_count;
static int menu_directory_saved;
static int menu_initialized;
static int direct_startup;
static int authority_startup;
int WebAuthorityStartup(void)
{
    return authority_startup;
}

int WebDirectStartup(void)
{
    return direct_startup;
}
static struct {
    unsigned int scale;
    PsyzDitherMode dithering;
    unsigned int limit;
    unsigned int car_lod_distance;
    unsigned int draw_distance;
} render_settings = { PSYZ_INTERNAL_RES_AUTO, PSYZ_DITHER_AUTO, 120, 1, 1 };
unsigned int WebCarLodDistanceScale = 1;
unsigned int WebDrawDistanceScale = 1;
static int render_settings_pending = 1;
s32 MainFrameCount;
s8 MainControllerTypes[4] = { -1, -1, -1, -1 };
void* MainSavedStack;
void SoundResolveEmitterSymbols(void);
extern s32 MenuTicks;
void MenuInitialize(u32 mode);
void MenuShutdown(void);
void WebMenuBindImports(void);
void WebCardFlush(void);

/* UI callbacks may run while VSync has suspended a frame. Apply at its next boundary. */
EMSCRIPTEN_KEEPALIVE void WebSetRenderScale(unsigned int scale)
{
    if (scale <= PSYZ_INTERNAL_RES_MAX) {
        render_settings.scale = scale;
        render_settings_pending = 1;
    }
}

EMSCRIPTEN_KEEPALIVE void WebSetCarLodDistance(unsigned int scale)
{
    if (scale == 1 || scale == 2 || scale == 4 || scale == 8) {
        render_settings.car_lod_distance = scale;
        render_settings_pending = 1;
    }
}

EMSCRIPTEN_KEEPALIVE void WebSetDrawDistance(unsigned int scale)
{
    if (scale == 1 || scale == 2 || scale == 4 || scale == WEB_DRAW_DISTANCE_MAX_SCALE) {
        render_settings.draw_distance = scale;
        render_settings_pending = 1;
    }
}

EMSCRIPTEN_KEEPALIVE void WebSetRenderDithering(int mode)
{
    if (mode == PSYZ_DITHER_AUTO || mode == PSYZ_DITHER_OFF) {
        render_settings.dithering = mode;
        render_settings_pending = 1;
    }
}

EMSCRIPTEN_KEEPALIVE void WebSetRenderLimit(unsigned int rate)
{
    if (rate == 0 || rate == 30 || rate == 60 || rate == 120) {
        render_settings.limit = rate;
        render_settings_pending = 1;
    }
}

static void apply_render_settings(void)
{
    if (!render_settings_pending)
        return;
    const unsigned int scale = render_settings.scale;
    const PsyzDitherMode dithering = render_settings.dithering;
    render_settings_pending = 0;
    WebRenderSetLimit(render_settings.limit);
    WebCarLodDistanceScale = render_settings.car_lod_distance;
    WebDrawDistanceScale = render_settings.draw_distance;
    Psyz_VideoSetInternalResolution(scale);
    Psyz_VideoSetDitheringMode(dithering);
    EM_ASM(
        {
            tm4Port.renderScale = $0;
            tm4Port.renderDithering = $1;
            tm4Port.carLodDistance = $2;
            tm4Port.drawDistance = $3;
            tm4Port.renderLimit = tm4Port.networkSynchronous ? 30 : $4;
        },
        Psyz_VideoGetInternalResolution(), Psyz_VideoGetDitheringMode(),
        WebCarLodDistanceScale, WebDrawDistanceScale, render_settings.limit);
}

static unsigned int presented_frames;

static void count_presented_frame(void)
{
    ++presented_frames;
    static unsigned int reported_scale;
    unsigned int scale = Psyz_VideoGetInternalResolution();
    if (scale != reported_scale) {
        reported_scale = scale;
        EM_ASM({ tm4Port.renderScale = $0; }, scale);
    }
}

EMSCRIPTEN_KEEPALIVE unsigned int WebGetPresentedFrames(void)
{
    return presented_frames;
}

static void count_registry(RegistryDirectory* directory)
{
    ++directory_count;
    resource_count += RegGetNumberOfFilesP(directory);
    for (s32 i = 0; i < RegGetNumberOfDirectoriesP(directory); ++i)
        count_registry(RegGetDirectoryPtrPN(directory, i));
}

void WebLoadArchiveAt(const char* path, char* registration, char* destination)
{
    CdlLOC location;
    s32 size = CDFileGetSizeAndLoc(path, &location);
    void* image = size > 0 ? CDLoadFileLocSize(&location, size, 0, NULL) : NULL;
    if (!image) {
        fprintf(stderr, "Cannot load archive: %s\n", path);
        exit(1);
    }
    if (!RegAddReg(destination, image, registration)) {
        fprintf(stderr, "TM4 registry rejected %s\n", path);
        exit(1);
    }
    MemFree(image);
}

void WebLoadArchive(const char* path, char* registration)
{
    WebLoadArchiveAt(path, registration, "/");
}

static void* resource(char* path)
{
    void* data = RegGetFileDataS(path);
    if (!data) {
        fprintf(stderr, "Missing menu resource: %s\n", path);
        exit(1);
    }
    return data;
}

static s32 load_texture(char* path, s32 type, s32 size, void* data, char* registration)
{
    SystemForwardType12(path, type, size, data, registration);
    /* Native MENU stays resident; keep its images to restore VRAM after a match. */
    return !registration || strcmp(registration, "MENU") != 0;
}

static void load_registry(void)
{
    u32 heap_offset = 0;
#ifdef TM4_WEB_TEST_HOOKS
    if (EM_ASM_INT({ return !!globalThis.tm4TestShiftResourceHeap; }))
        heap_offset = 65536;
#endif
    MemInitHeap((u8*)heap + heap_offset, sizeof(heap) - heap_offset);
    RegistryInitialize();
    WebNativeModulesInitialize();
    RegistrySetTypeHandler(REG_FILE_TYPE_TEXTURE, load_texture);
    RegistrySetTypeHandler(REG_FILE_TYPE_SOUND_VAB, SystemForwardType16);
    SoundResolveEmitterSymbols();
    CDInitialize();
    WebLoadArchive("/DATA/MAIN.MR", "MAIN");
    count_registry(RegGetCurrentDirectoryPtr());
    printf("TM4 registry: %u directories, %u resources\n", directory_count, resource_count);
    EM_ASM(
        { globalThis.tm4Port = ({ registryReady : true, directories : $0, resources : $1 }); },
        directory_count, resource_count);
}

static void set_menu_mask(int enabled)
{
    DR_STP command;
    SetDrawStp(&command, enabled);
    DrawPrim(&command);
    DrawSync(0);
}

static void initialize_menu(void)
{
    ResetGraph(0);
    WebLoadingBackground("LEGAL.TIM");
    WebLoadArchive("/DATA/MENU.MR", "MENU");
    GameInfo.mode = GAME_MODE_MENU;
    GameInfo.next_mode = 0;
    LoadingInitializeDisplay();
    WebMenuBindImports();
    menu_directory_saved = CDPushDirectory();
    MenuInitialize(1);
    menu_initialized = 1;
    set_menu_mask(1);
    MenuTicks = 0;
    SetDispMask(1);
    EM_ASM({ globalThis.tm4Port.screen = 'main'; });
}

void WebReturnToMenu(void)
{
    EM_ASM({ tm4Port.menuReady = false; });
    WebLoadingBackground("TITLE.TIM");
    GameInfo.mode = GAME_MODE_MENU;
    GameInfo.next_mode = 0;
    LoadingInitializeDisplay();
    LoadBitmap(resource("/menu/menu.bit"));
    LoadBitmap(resource("/menu/menu.clt"));
    MenuCurrentScreen = GameInfo.save_menu ? &MenuScreenSaveTournament : &MenuScreenMain;
    GameInfo.save_menu = 0;
    menu_directory_saved = CDPushDirectory();
    MenuInitialize(0);
    menu_initialized = 1;
    set_menu_mask(1);
    MenuTicks = 0;
    SetDispMask(1);
}

/* SystemRunMenu restores its caller's CD directory after the menu returns. */
void WebLeaveMenu(void)
{
    EM_ASM({ tm4Port.menuReady = false; });
    if (!menu_initialized)
        return;
    MenuShutdown();
    menu_initialized = 0;
    if (menu_directory_saved)
        CDPopDirectory();
    menu_directory_saved = 0;
    set_menu_mask(0);
}

static void draw_menu(void)
{
    MenuGraphicsBuffer = MenuGraphicsBuffer->next;
    MenuGraphics* graphics = MenuGraphicsBuffer;
    PadGetPad(4);
    FontPrimsReset(&graphics->font_prims);
    MenuResetQuadPool(&graphics->quad_pool);
    ClearOTagR(graphics->ordering_table, 3);
    ObjectProcess();
    SoundProcess();
    WebSubpixelBegin(WEB_SUBPIXEL_MENU);
    WebSubpixelSelect(WEB_SUBPIXEL_MENU);
#ifdef TM4_WEB_TEST_HOOKS
    WebTestDrawMenu(graphics);
#else
    MenuDrawScreen(graphics);
#endif
    WebSubpixelSelect(WEB_SUBPIXEL_NONE);
    addPrim(&graphics->ordering_table[2], &graphics->draw);
    DrawSync(0);
    VSync(0);
    PutDispEnv(&graphics->display);
    WebSubpixelDraw(WEB_SUBPIXEL_MENU, &graphics->ordering_table[2]);
    MenuProcessScreenInput();
    WebCardFlush();
    ++MenuTicks;
    ++frame_count;
    EM_ASM(
        {
            globalThis.tm4Port.frames = $0;
            globalThis.tm4Port.selected = $1;
            globalThis.tm4Port.screen = UTF8ToString($2);
            globalThis.tm4Port.menuMode = $3;
            globalThis.tm4Port.selectedWorld = UTF8ToString($4);
            globalThis.tm4Port.selectedCar = UTF8ToString($5);
            globalThis.tm4Port.menuReady = !$6 && !$7;
            globalThis.tm4Port.gameType = $8;
            globalThis.tm4Port.dialog = UTF8ToString($9);
            globalThis.tm4Port.soundVolume = $10;
            globalThis.tm4Port.menuGasBinding = $11;
            globalThis.tm4Port.controlAction = $12;
            globalThis.tm4Port.playerCount = $13;
            globalThis.tm4Port.menuPlayer = $14;
        },
        frame_count, MenuCurrentScreen->selected, MenuCurrentScreen->text, GameInfo.next_mode,
        MenuGameState.world_name, MenuGameState.character_names[0], MenuInputSuppressed,
        MenuTransitionActive, MenuGameState.game_type,
        MenuCurrentMessage ? MenuCurrentMessage->text : "", MenuGameState.sound_volume,
        MenuGameState.players[0].bindings[0].actions[GameControlGas], MenuSelectedControlAction,
        MenuGameState.player_count, MenuCurrentPlayer);
    if (GameInfo.next_mode) {
        WebLeaveMenu();
        WebLevelStart();
    }
}

static void startup_intro(void)
{
    WebMovieStart("INTRO", 1, initialize_menu);
}

static void initialize_platform(void)
{
    ResetGraph(0);
    Psyz_OverlayFrameCB(count_presented_frame);
    PadInitPad();
    if (!authority_startup && Psyz_AudioInit() != 0) {
        fprintf(stderr, "Cannot initialize browser audio\n");
        exit(1);
    }
    WebMusicInitialize();
    RedbookInitialize();
    SetVideoMode(MODE_NTSC);
    GameInitialize();
    SoundInitializeSpu();
    if (!authority_startup)
        Psyz_VideoSetVsyncMode(PSYZ_VSYNC_ON);
    if (!direct_startup)
        WebMovieStart("N89STUDI", 0, startup_intro);
}

static void browser_frame(void)
{
    if (WebLevelCheckpointActive() && !WebNetRenderedPrediction())
        return;
    apply_render_settings();
    WebApplyCheats();
#ifdef TM4_WEB_TEST_HOOKS
    WebTestStartPendingMovie();
#endif
    if (WebMovieActive())
        WebMovieFrame();
    else if (WebLevelActive())
        WebLevelFrame();
    else if (!direct_startup) {
        static double next_frame;
        double now = emscripten_get_now();
        if (now >= next_frame) {
            draw_menu();
            next_frame += 1000.0 / 30;
            if (next_frame < now)
                next_frame = now + 1000.0 / 30;
        }
    }
}

int main(int argc, char** argv)
{
    direct_startup = argc > 1 && !strcmp(argv[1], "--session");
    authority_startup = argc > 2 && !strcmp(argv[2], "--authority");
    load_registry();
    initialize_platform();
    WebNetPublishCatalog();
    EM_ASM({ tm4Port.platformReady = true; });
    if (authority_startup)
        emscripten_exit_with_live_runtime();
    emscripten_set_main_loop(browser_frame, 0, 1);
    return 0;
}
