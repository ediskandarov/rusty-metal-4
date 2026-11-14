#include "port/web/net_match.h"
#include "port/web/net_state.h"
#include "port/web/participant.h"
#include "port/web/snapshot.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"
#include "tm4/main/registry.h"
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
    char* argv[] = { "tm4-headless", "--session", "--simulation-only", NULL };
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
/* Fixed wasm32 wire layout; all scalar members occupy four bytes. */
typedef struct {
    u32 tick, capacity;
    s32 remaining, winner, round_finished, accepts_continue, next_mode;
    u32 digest, sections[5];
    s32 scores[8][2];
    const char* unsupported;
} HeadlessRoundState;
_Static_assert(sizeof(HeadlessRoundState) == 120, "headless round state ABI");
static HeadlessRoundState round_state;
static u8 portable_bytes[WebSnapshotMaxBytes];
static const char* last_error;

const HeadlessRoundState* HeadlessState(void)
{
    if (!WebNetMatchActive()) {
        last_error = "no active match";
        return NULL;
    }
    digest = WebNetCaptureDigest(1);
    round_state = (HeadlessRoundState) {
        .tick = MainFrameCount,
        .capacity = WebNetSlotCapacity(),
        .remaining = GameInfo.active_player_count,
        .winner = GameInfo.deathmatch_winner,
        .round_finished = GameInfo.deathmatch_finished,
        .accepts_continue = GameInfo.deathmatch_accept_input,
        .next_mode = GameInfo.next_mode,
        .sections = { digest.session, digest.cars, digest.objects, digest.world, digest.sound },
        .unsupported = digest.unsupported,
    };
    round_state.digest = round_state.sections[0];
    for (u32 i = 1; i < 5; ++i)
        round_state.digest = (round_state.digest ^ round_state.sections[i]) * 16777619u;
    WebParticipantState participants;
    WebParticipantCapture(&participants);
    for (u32 i = 0; i < round_state.capacity; ++i) {
        round_state.scores[i][0] = participants.slots[i].frags;
        round_state.scores[i][1] = participants.slots[i].deaths;
    }
    last_error = digest.unsupported;
    return &round_state;
}

u32 HeadlessWorldCount(void)
{
    return GameGetNumberOfWorlds();
}
const char* HeadlessWorldName(u32 index)
{
    return index < (u32)GameGetNumberOfWorlds() ? GameGetWorldName(index) : NULL;
}
u32 HeadlessCarCount(void)
{
    return RegGetNumberOfDirectoriesS("/objects/car/characters");
}
const char* HeadlessCarName(u32 index)
{
    return index < HeadlessCarCount() ? RegGetDirectoryNameSN("/objects/car/characters", index)
                                      : NULL;
}
_Static_assert(sizeof(WebParticipantResult) == 16, "headless participant result ABI");
static WebParticipantState participant_state;
const WebParticipantResult* HeadlessParticipants(void)
{
    WebParticipantCapture(&participant_state);
    return participant_state.slots;
}
const char* HeadlessError(void)
{
    return last_error;
}
u8* HeadlessPortableBuffer(void)
{
    return portable_bytes;
}
u32 HeadlessPortableCapture(void)
{
    u32 length = 0;
    last_error = WebNetCapturePortableInto(portable_bytes, sizeof(portable_bytes), &length);
    return length;
}
int HeadlessPortableRestore(u32 length)
{
    if (!length || length > sizeof(portable_bytes)) {
        last_error = "portable length";
        return 0;
    }
    last_error = WebNetRestorePortableFrom(portable_bytes, length);
    return last_error == NULL;
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
