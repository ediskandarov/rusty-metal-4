#include "render_sync.h"
#include "tm4/main/game.h"
#include "tm4/main/render.h"
#include "tm4/main/sync.h"
#include <emscripten.h>
#include <libetc.h>
#include <libgpu.h>

static int interpolation_frame;
static unsigned int last_vblank;
static unsigned int elapsed_vblanks;
#ifdef TM4_WEB_TEST_HOOKS
static unsigned int test_delay_ms;

EMSCRIPTEN_KEEPALIVE void WebTestRenderDelay(unsigned int milliseconds)
{
    test_delay_ms = milliseconds;
}
#endif

void WebRenderPresentLevelFrame(int interpolate)
{
    interpolation_frame = interpolate;
    RenderPresent(1);
    interpolation_frame = 0;
}

void WebRenderResetTiming(void)
{
    last_vblank = VSync(-1);
    VB_FrameVBlanks[0] = 0;
    VB_DrawComplete[0] = 1;
}

unsigned int WebRenderWaitForFrame(void)
{
    unsigned int target = interpolation_frame ? 1 : 2;
#ifdef TM4_WEB_TEST_HOOKS
    if (test_delay_ms && !GameInfo.pause_player)
        emscripten_sleep(test_delay_ms);
#endif
    DrawSync(0);
    if (GameInfo.pause_player) {
        /* MAIN disables its adaptive VBlank callbacks while PauseMenu runs. */
        VSync(2);
        last_vblank = VSync(-1);
        VB_FrameVBlanks[0] = 2;
    } else {
        unsigned int now;
        /* Present/yield at least once. Browser refresh rates need not be 60 Hz;
         * count emulated VBlanks, not requestAnimationFrame callbacks. */
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
