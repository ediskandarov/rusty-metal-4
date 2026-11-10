#include "render_sync.h"
#include "interpolation.h"
#include "net_match.h"
#include "tm4/main/game.h"
#include "tm4/main/render.h"
#include "tm4/main/sync.h"
#include <emscripten.h>
#include <libetc.h>
#include <libgpu.h>

static unsigned int render_limit = 120;
static double render_deadline;
static int level_frame;
static unsigned int last_vblank;
static unsigned int elapsed_vblanks;
#ifdef TM4_WEB_TEST_HOOKS
static unsigned int test_delay_ms;

EMSCRIPTEN_KEEPALIVE void WebTestRenderDelay(unsigned int milliseconds)
{
    test_delay_ms = milliseconds;
}
#endif

/* Local PsyZ extensions: presentation and emulated VBlank advance independently. */
void Psyz_VideoPresentFrame(void);
void Psyz_ResetDisplayClock(void);
unsigned int Psyz_PollDisplayClock(void);

void WebRenderSetLimit(unsigned int rate)
{
    if (render_limit != rate) {
        render_limit = rate;
        render_deadline = 0;
    }
}

static unsigned int effective_render_limit(void)
{
    /* Network play displays simulation poses; larger splits reuse packet storage. */
    if (WebNetMatchActive() || !WebRenderGetMotionSettings().enabled || GameInfo.player_count > 2)
        return SIMULATION_FPS;
    return render_limit;
}

int WebRenderBeginLevelFrame(void)
{
    unsigned int rate = effective_render_limit();
    if (!rate)
        return 1;
    double now = emscripten_get_now();
    double interval = 1000.0 / rate;
    if (!render_deadline)
        render_deadline = now;
    if (now < render_deadline)
        return 0;
    render_deadline += interval;
    if (render_deadline < now - interval)
        render_deadline = now + interval;
    return 1;
}

void WebRenderPresentLevelFrame(void)
{
    level_frame = GameInfo.mode != GAME_MODE_DEMO;
    RenderPresent(1);
    level_frame = 0;
}

void WebRenderResetTiming(void)
{
    last_vblank = VSync(-1);
    Psyz_ResetDisplayClock();
    render_deadline = 0;
    VB_FrameVBlanks[0] = 0;
    VB_DrawComplete[0] = 1;
}

unsigned int WebRenderWaitForFrame(void)
{
    unsigned int target = effective_render_limit() == 30 ? 2 : 1;
#ifdef TM4_WEB_TEST_HOOKS
    if (test_delay_ms && !GameInfo.pause_player && !WebNetMatchActive())
        emscripten_sleep(test_delay_ms);
#endif
    DrawSync(0);
    if (level_frame && !GameInfo.pause_player) {
        Psyz_VideoPresentFrame();
        elapsed_vblanks = Psyz_PollDisplayClock();
        last_vblank = VSync(-1);
        VB_FrameVBlanks[0] = elapsed_vblanks;
        VB_DrawComplete[0] = 1;
        return target;
    }
    /* Pause, demo and teardown retain their original blocking cadence. */
    target = 2;
    if (GameInfo.pause_player) {
        VSync(2);
        last_vblank = VSync(-1);
        VB_FrameVBlanks[0] = 2;
    } else {
        unsigned int now;
        do {
            VSync(0);
            now = VSync(-1);
        } while (VB_FrameVBlanks[0] + now - last_vblank < target);
        VB_FrameVBlanks[0] += now - last_vblank;
        last_vblank = now;
    }
    elapsed_vblanks = VB_FrameVBlanks[0];
    VB_DrawComplete[0] = 1;
    return target;
}

void WebRenderReportFrame(int phase, int late, int face_budget, int minimum, int maximum)
{
    EM_ASM(
        {
            tm4Port.renderTiming = ({
                phase : $0,
                late : !!$1,
                faceBudget : $2,
                minimum : $3,
                maximum : $4,
                vblanks : $5,
                refreshPriority : !!$6
            });
            if (!tm4Port.renderPhaseCounts)
                tm4Port.renderPhaseCounts = ([ 0, 0, 0 ]);
            tm4Port.renderPhaseCounts[$0]++;
        },
        phase, late, face_budget, minimum, maximum, elapsed_vblanks, GameInfo.adaptive_frame_phase);
}
