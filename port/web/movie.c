/* Browser scheduling for movie_r's STR/VLC/MDEC playback. The compressed movie
 * and XA sectors are original; only CD delivery and the blocking loop change. */
#include <libgte.h>
#include "movie.h"
#include "level.h"
#include "music.h"
#include "tm4/main/game.h"
#include "tm4/main/pad.h"
#include "tm4/main/registry.h"
#include "tm4/main/sound.h"
#include <ctype.h>
#include <emscripten.h>
#include <libetc.h>
#include <libgpu.h>
#include <libpress.h>
#include <psyz/cd.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define RAW_SECTOR 2352
#define VIDEO_CHUNK 2016
#define VLC_WORDS (0x28000 / 4)
static u_long compressed[32768], runlevel[VLC_WORDS], strip[24 * 240 / 2];
static FILE* stream;
static unsigned generation, frame, frame_limit;
static int active, ready, playing, allow_skip, page;
static char movie_name[32];
static void (*completion)(void);
static double audio_tail_started;

// clang-format off
EM_JS(void, fetch_movie, (const char* name, unsigned request), {
    const movie = UTF8ToString(name);
    const state = tm4Port.movie = { name : movie, active : true, loading : true, frame : 0 };
    if (Module.SDL3?.audioContext?.state !== 'running' && !document.getElementById('tm4-movie-start')) {
        const button = document.createElement('button');
        button.id = 'tm4-movie-start';
        button.textContent = 'Click to start';
        button.style.cssText
            = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);padding:16px 28px;font:20px sans-serif;cursor:pointer;z-index:10';
        button.onclick = () => {
            Module.SDL3.audioContext.resume();
            button.remove();
            Module.canvas.focus();
        };
        document.body.appendChild(button);
    }
    const controller = Module.tm4MovieFetch = new AbortController();
    fetch('movies/' + movie + '.STR', {signal: controller.signal}).then(response => {
        if (!response.ok) throw new Error('Movie download failed: ' + response.status);
        return response.arrayBuffer();
    }).then(bytes => {
        if (tm4Port.movie !== state || !state.active) return;
        FS.writeFile('/movie.bin', new Uint8Array(bytes), {canOwn: true});
        FS.writeFile('/movie.cue', 'FILE "movie.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n');
        Module._WebMovieDeliver(request, 1);
    }).catch(error => {
        if (tm4Port.movie !== state || !state.active) return;
        console.warn(error.message);
        Module._WebMovieDeliver(request, 0);
    });
});

EM_JS(int, audio_ready, (), {
    const context = Module.SDL3?.audioContext;
    // SDL creates its context on audio initialization. The first gesture resumes it.
    if (context && context.state !== 'running')
        return 0;
    document.getElementById('tm4-movie-start')?.remove();
    return 1;
});

// clang-format on

static unsigned read16(const unsigned char* p)
{
    return p[0] | p[1] << 8;
}

static unsigned read32(const unsigned char* p)
{
    return read16(p) | read16(p + 2) << 16;
}

static void finish(const char* reason)
{
    CdControlB(CdlPause, NULL, NULL);
    WebMusicMovieMode(0);
    Psyz_CdSetDiskPath(NULL);
    if (stream)
        fclose(stream);
    stream = NULL;
    unlink("/movie.bin");
    unlink("/movie.cue");
    DecDCTReset(1);
    RegRemoveReg("movie");
    active = ready = playing = 0;
    SoundSetMusicVolume(GameInfo.music_volume);
    // clang-format off
    EM_ASM(
        {
            Object.assign(tm4Port.movie, { active : false, playing : false, loading : false, reason : UTF8ToString($0), frame : $1 });
            (tm4Port.movieHistory ||= []).push({...tm4Port.movie});
            Module.tm4MovieFetch?.abort();
            Module.tm4MovieFetch = null;
            if (tm4Port.movie.reason !== 'complete' && tm4Port.movie.reason !== 'skipped')
                console.warn('Movie ' + tm4Port.movie.name + ': ' + tm4Port.movie.reason);
            document.getElementById('tm4-movie-start')?.remove();
        },
        reason, frame);
    // clang-format on
    void (*done)(void) = completion;
    completion = NULL;
    if (done)
        done();
}

EMSCRIPTEN_KEEPALIVE void WebMovieDeliver(unsigned request, int success)
{
    if (!active || request != generation)
        return;
    if (!success || !(stream = fopen("/movie.bin", "rb")) || Psyz_CdSetDiskPath("/movie.cue")) {
        finish("load failed");
        return;
    }
    ready = 1;
    EM_ASM({ tm4Port.movie.loading = false; });
}

void WebMovieStart(const char* name, int skip, void (*finished)(void))
{
    if (active)
        return;
    size_t length = strlen(name);
    if (!length || length >= sizeof(movie_name)) {
        if (finished)
            finished();
        return;
    }
    for (size_t i = 0; i <= length; ++i)
        movie_name[i] = toupper((unsigned char)name[i]);
    WebLoadArchive("/DATA/MOVIE.MR", "movie");
    char path[64];
    snprintf(path, sizeof(path), "/movie/frames/%s", name);
    for (char* p = path; *p; ++p)
        *p = tolower((unsigned char)*p);
    u_long* count = RegGetFileDataS(path);
    frame_limit = count ? *count : 0;
    completion = finished;
    active = 1;
    ready = playing = frame = page = 0;
    audio_tail_started = 0;
    allow_skip = skip;
    WebMusicControl(CdlPause, NULL, NULL);
    SoundStopSounds();
    SoundSetMusicVolume(16);
    RECT clear = { 0, 0, 480, 480 };
    ClearImage(&clear, 0, 0, 0);
    DISPENV display;
    SetDefDispEnv(&display, 0, 0, 320, 240);
    display.isrgb24 = 1;
    PutDispEnv(&display);
    SetDispMask(1);
    DecDCTReset(0);
    fetch_movie(movie_name, ++generation);
    if (!frame_limit)
        finish("missing frame count");
}

int WebMovieActive(void)
{
    return active;
}

/* PsyZ's StCdInterrupt is a stub. Assemble its STR payload here, then use its
 * real VLC and MDEC implementations, including the original RGB24 strip layout. */
static int decode_frame(void)
{
    unsigned char sector[RAW_SECTOR];
    unsigned chunks = 0, next = 0, number = 0, bytes = 0;
    while (fread(sector, 1, sizeof(sector), stream) == sizeof(sector)) {
        const unsigned char* h = sector + 24;
        if (read16(h) != 0x160 || read16(h + 2) != 0x8001)
            continue;
        unsigned chunk = read16(h + 4), total = read16(h + 6);
        if (!chunks) {
            chunks = total;
            number = read32(h + 8);
            bytes = read32(h + 12);
            if (!chunks || chunks * VIDEO_CHUNK > sizeof(compressed) || bytes > chunks * VIDEO_CHUNK
                || number != frame + 1 || read16(h + 16) != 320 || read16(h + 18) != 240)
                return 0;
        }
        if (chunk != next || total != chunks || read32(h + 8) != number)
            return 0;
        memcpy((unsigned char*)compressed + chunk * VIDEO_CHUNK, sector + 56, VIDEO_CHUNK);
        if (++next == chunks)
            break;
    }
    if (!chunks || next != chunks || DecDCTBufSize(compressed) >= VLC_WORDS
        || DecDCTvlc(compressed, runlevel))
        return 0;
    DecDCTReset(1);
    DecDCTin(runlevel, 3);
    for (int x = 0; x < 480; x += 24) {
        RECT destination = { x, page * 240, 24, 240 };
        DecDCTout(strip, sizeof(strip) / sizeof(strip[0]));
        if (DecDCToutSync(0))
            return 0;
        LoadImage(&destination, strip);
    }
    DrawSync(0);
    DISPENV display;
    SetDefDispEnv(&display, 0, page * 240, 320, 240);
    display.isrgb24 = 1;
    PutDispEnv(&display);
    page ^= 1;
    frame = number;
    return 1;
}

void WebMovieFrame(void)
{
    if (allow_skip) {
        PadGetPad(8);
        for (int i = 0; i < 8; ++i)
            if (PadJpad[i].pressed_buttons & (PADstart | PADRdown)) {
                finish("skipped");
                return;
            }
    }
    if (!ready || !audio_ready())
        return;
    if (!playing) {
        if (!decode_frame()) {
            finish("decode failed");
            return;
        }
        CdlLOC position;
        CdIntToPos(0, &position);
        CdControlB(CdlSetloc, (u_char*)&position, NULL);
        CdControlB(CdlDemute, NULL, NULL);
        WebMusicMovieMode(1);
        CdRead2(CdlModeStream | CdlModeSpeed | CdlModeRT);
        playing = 1;
    }
    int audio_ended;
    unsigned samples = WebMusicMovieSamples(&audio_ended);
    unsigned clock_samples = samples;
    // Some original movies end XA before their final video frames (INTRO by 0.43 s).
    // Continue only that silent tail on the browser clock after native XA reports EOF.
    if (audio_ended) {
        double now = emscripten_get_now();
        if (!audio_tail_started)
            audio_tail_started = now;
        clock_samples += (unsigned)((now - audio_tail_started) * 44.1);
    }
    // 150 raw sectors/second, ten sectors/frame: original TM4 movies are 15 fps.
    unsigned target = clock_samples / (44100 / 15) + 1;
    if (target > frame_limit) {
        if (frame == frame_limit) {
            finish("complete");
            return;
        }
        target = frame_limit;
    }
    for (int budget = 0; frame < target && budget < 8; ++budget)
        if (!decode_frame()) {
            finish("decode failed");
            return;
        }
    VSync(0);
    EM_ASM(
        {
            Object.assign(
                tm4Port.movie, { frame : $0, frames : $1, audioFrames : $2, playing : true });
        },
        frame, frame_limit, samples);
}

void WebMovieEnding(void (*finished)(void))
{
    char path[160];
    snprintf(
        path, sizeof(path), "/objects/car/characters/%s/filename", GameInfo.character_names[0]);
    const char* filename = RegGetFileDataS(path);
    char frame_path[160];
    snprintf(frame_path, sizeof(frame_path), "/movie/frames/%s", filename ? filename : "generic");
    // Frame metadata is scoped to the same MOVIE.MR registration as playback.
    WebLoadArchive("/DATA/MOVIE.MR", "movie");
    for (char* p = frame_path; *p; ++p)
        *p = tolower((unsigned char)*p);
    int exists = RegGetFileDataS(frame_path) != NULL;
    RegRemoveReg("movie");
    GameInfo.intro_character = NULL;
    WebMovieStart(exists && filename ? filename : "GENERIC", 0, finished);
}

#ifdef TM4_WEB_TEST_HOOKS
static char pending_movie[sizeof(movie_name)];
static int pending_allow_skip;

static void queue_test_movie(const char* name, int skip)
{
    if (active || strlen(name) >= sizeof(pending_movie))
        return;
    strcpy(pending_movie, name);
    pending_allow_skip = skip;
}

/* Browser test calls can arrive while draw_menu is suspended inside VSync. */
void WebTestStartPendingMovie(void)
{
    if (!pending_movie[0] || active)
        return;
    WebLeaveMenu();
    WebMovieStart(pending_movie, pending_allow_skip, WebReturnToMenu);
    pending_movie[0] = 0;
}

EMSCRIPTEN_KEEPALIVE void WebTestNamedMovie(const char* name)
{
    queue_test_movie(name, 0);
}

EMSCRIPTEN_KEEPALIVE void WebTestMovie(int ending)
{
    queue_test_movie(ending ? "GENERIC" : "N89STUDI", 1);
}
#endif
