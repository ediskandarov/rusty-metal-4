#include "port/web/net_match.h"
#include "port/web/net_state.h"
#include "tm4/main/main.h"
#include <emscripten.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char** argv);
static u8 canonical[256 * 1024];
static WebNetStateDigest digest;
static int initialized;
EMSCRIPTEN_KEEPALIVE int HeadlessInitialize(void)
{
    if (initialized)
        return 0;
    initialized = 1;
    char* argv[] = { "tm4-headless", "--session", "--authority", NULL };
    return main(3, argv) == 0;
}
EMSCRIPTEN_KEEPALIVE u32 HeadlessCapture(void)
{
    if (!WebNetMatchActive())
        return 0;
    digest = WebNetCaptureDigest(1);
    return digest.unsupported ? 0 : WebNetCaptureBytes(canonical, sizeof(canonical));
}
EMSCRIPTEN_KEEPALIVE const u8* HeadlessCanonical(void)
{
    return canonical;
}
EMSCRIPTEN_KEEPALIVE const WebNetStateDigest* HeadlessDigest(void)
{
    return &digest;
}
EMSCRIPTEN_KEEPALIVE u32 HeadlessTick(void)
{
    return MainFrameCount;
}
_Noreturn void WebHeadlessRequireHost(const char* operation, const char* file, int line)
{
    fprintf(stderr, "Required host capability unavailable: %s at %s:%d\n", operation, file, line);
    abort();
}

/* Authority ticks are externally stepped. Presentation clocks/schedulers are unsupported;
 * gameplay GetCurrentTime() continues to read MainFrameCount, including after restore. */
double emscripten_get_now(void)
{
    WebHeadlessRequireHost(__func__, __FILE__, __LINE__);
}
void emscripten_sleep(unsigned int milliseconds)
{
    WebHeadlessRequireHost(__func__, __FILE__, __LINE__);
}
void emscripten_set_main_loop(em_callback_func callback, int fps, bool infinite)
{
    WebHeadlessRequireHost(__func__, __FILE__, __LINE__);
}
int emscripten_set_interval(void (*callback)(void*), double ms, void* data)
{
    WebHeadlessRequireHost(__func__, __FILE__, __LINE__);
}

#ifdef TM4_WEB_TEST_HOOKS
EM_JS(int, headless_required_js, (), { return 1; });
uint32_t Psyz_OsNowUs(void);
/* Negative probes only; every branch must terminate before returning a value. */
int HeadlessTestRequiredHost(int kind)
{
    switch (kind) {
    case 0:
        EM_ASM({ globalThis.requiredHostEffect = true; });
        break;
    case 1:
        return EM_ASM_INT({ return 1; });
    case 2:
        return (int)EM_ASM_DOUBLE({ return 1.0; });
    case 3:
        return headless_required_js();
    case 4:
        return (int)emscripten_get_now();
    case 5:
        return emscripten_set_interval(NULL, 100, NULL);
    case 6:
        emscripten_sleep(1);
        break;
    case 7:
        emscripten_set_main_loop(NULL, 0, false);
        break;
    case 8:
        return (int)Psyz_OsNowUs();
    }
    return 0;
}
#endif
