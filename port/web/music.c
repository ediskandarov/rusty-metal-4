#include "music.h"
#include <emscripten.h>
#include <emscripten/eventloop.h>
#include <psyz/audio.h>
#include <stdlib.h>
#include <string.h>

typedef struct WebMusicTrack {
    int start, end, toc;
} WebMusicTrack;
static WebMusicTrack music_tracks[100];
static int music_track_count, music_leadout;

EMSCRIPTEN_KEEPALIVE void WebMusicConfigureTrack(int track, int start, int end, int toc)
{
    if (track > 0 && track < 100 && start >= 0 && end > start) {
        music_tracks[track] = (WebMusicTrack){ start, end, toc };
    }
}

EMSCRIPTEN_KEEPALIVE void WebMusicConfigureDisc(int count, int leadout)
{
    if (count > 0 && count < 100) {
        music_track_count = count;
        music_leadout = leadout;
    }
}

static int movie_mode, movie_ended;
static unsigned int movie_samples, movie_generation;
extern size_t __real_Psyz_CdPullSamples(short* output, size_t frames);

void WebMusicMovieMode(int enabled)
{
    Psyz_AudioLock();
    movie_mode = enabled;
    movie_samples = movie_ended = 0;
    ++movie_generation;
    Psyz_AudioUnlock();
}

unsigned int WebMusicMovieSamples(int* ended)
{
    Psyz_AudioLock();
    unsigned int result = movie_samples;
    *ended = movie_ended;
    Psyz_AudioUnlock();
    return result;
}

static CdlCB ready_callback;
static short* samples;
static int cached_track, current_track, playing, muted;
static u_char mode;
static unsigned int generation, sample_count, sample_cursor;
static int requested_sector;
static unsigned int samples_read, nonzero_samples;

EM_JS(void, fetch_track, (int track, unsigned int generation), {
    globalThis.tm4Assets.readAudio(track).then(bytes => {
        const pointer = Module._malloc(bytes.byteLength);
        if (!pointer) throw new Error('Cannot allocate CD audio buffer');
        HEAPU8.set(new Uint8Array(bytes), pointer);
        Module._WebMusicDeliver(generation, track, pointer, bytes.byteLength);
    }).catch(error => { console.error('CD audio:', error); });
});

EMSCRIPTEN_KEEPALIVE void WebMusicDeliver(
    unsigned int request, int track, short* data, unsigned int bytes)
{
    short* previous = NULL;
    Psyz_AudioLock();
    if (request == generation && track == current_track
        && bytes == (unsigned int)(music_tracks[track].end - music_tracks[track].start) * 2352) {
        previous = samples;
        samples = data;
        cached_track = track;
        sample_count = bytes / sizeof(short);
        sample_cursor = (requested_sector - music_tracks[track].start) * 1176;
    } else {
        previous = data;
    }
    Psyz_AudioUnlock();
    free(previous);
}

/* The existing SPU mixer still owns CD volume, master volume and voice mixing. */
size_t __wrap_Psyz_CdPullSamples(short* output, size_t frames)
{
    Psyz_AudioLock();
    int movie = movie_mode;
    unsigned int request = movie_generation;
    Psyz_AudioUnlock();
    if (movie) {
        size_t count = __real_Psyz_CdPullSamples(output, frames);
        Psyz_AudioLock();
        if (movie_mode && movie_generation == request) {
            movie_samples += count;
            if (movie_samples && count < frames)
                movie_ended = 1;
        }
        Psyz_AudioUnlock();
        return count;
    }
    size_t count = 0;
    Psyz_AudioLock();
    if (playing && cached_track == current_track) {
        count = (sample_count - sample_cursor) / 2;
        if (count > frames)
            count = frames;
        for (size_t i = 0; i < count * 2; ++i) {
            short sample = muted ? 0 : samples[sample_cursor + i];
            output[i] = sample;
            nonzero_samples += sample != 0;
        }
        sample_cursor += count * 2;
        samples_read += count;
    }
    Psyz_AudioUnlock();
    return count;
}

static int play_sector(int sector)
{
    int track;
    for (track = 2; track <= music_track_count; ++track)
        if (sector >= music_tracks[track].start && sector < music_tracks[track].end)
            break;
    if (track > music_track_count)
        return 0;
    Psyz_AudioLock();
    requested_sector = sector;
    current_track = track;
    playing = 1;
    unsigned int request = ++generation;
    int cached = cached_track == track;
    if (cached)
        sample_cursor = (sector - music_tracks[track].start) * 1176;
    Psyz_AudioUnlock();
    if (!cached)
        fetch_track(track, request);
    return 1;
}

int WebMusicControl(u_char command, u_char* parameter, u_char* result)
{
    if (command == CdlPlay && parameter)
        return play_sector(CdPosToInt((CdlLOC*)parameter));
    Psyz_AudioLock();
    switch (command) {
    case CdlPlay:
        playing = current_track != 0;
        break;
    case CdlStop:
        ++generation;
        current_track = 0;
        playing = 0;
        break;
    case CdlPause:
        playing = 0;
        break;
    case CdlMute:
        muted = 1;
        break;
    case CdlDemute:
        muted = 0;
        break;
    case CdlSetmode:
        if (!parameter) {
            Psyz_AudioUnlock();
            return 0;
        }
        mode = *parameter;
        break;
    default:
        Psyz_AudioUnlock();
        return 0;
    }
    Psyz_AudioUnlock();
    if (result)
        memset(result, 0, 8);
    return 1;
}

int WebMusicControlB(u_char command, u_char* parameter, u_char* result)
{
    return WebMusicControl(command, parameter, result);
}

CdlCB WebMusicReadyCallback(CdlCB callback)
{
    CdlCB previous = ready_callback;
    ready_callback = callback;
    return previous;
}

int WebMusicGetToc(CdlLOC* toc)
{
    CdIntToPos(music_leadout, &toc[0]);
    for (int i = 1; i <= music_track_count; ++i)
        CdIntToPos(music_tracks[i].toc, &toc[i]);
    return music_track_count;
}

static void poll_music(void* unused)
{
    Psyz_AudioLock();
    int ready = playing && current_track && current_track == cached_track;
    int track = current_track;
    int ended = ready && sample_cursor == sample_count;
    int sector = ready ? music_tracks[track].start + sample_cursor / 1176 : requested_sector;
    unsigned int frames = samples_read, nonzero = nonzero_samples;
    int active = playing, silent = muted;
    unsigned int request = generation;
    u_char current_mode = mode;
    Psyz_AudioUnlock();
    EM_ASM(
        {
            tm4Port.music = ({
                track : $0,
                sector : $1,
                playing : !!$2,
                ready : !!$3,
                muted : !!$4,
                frames : $5,
                nonzero : $6
            });
        },
        track, sector, active, ready, silent, frames, nonzero);
    if (!ready)
        return;
    int stopped = ended && ((current_mode & CdlModeAP) || track == music_track_count);
    if (stopped) {
        Psyz_AudioLock();
        playing = 0;
        Psyz_AudioUnlock();
    }
    if (ready_callback && (stopped || (current_mode & CdlModeRept))) {
        CdlLOC position;
        CdIntToPos(sector, &position);
        u_char result[8] = { 0 };
        /* Without AutoPause, the next track is a position report, not DataEnd. */
        result[1] = itob(ended && !stopped ? track + 1 : track);
        result[3] = position.minute;
        result[4] = position.second;
        result[5] = position.sector;
        ready_callback(stopped ? CdlDataEnd : CdlDataReady, result);
    }
    Psyz_AudioLock();
    int continue_disc = ended && !stopped && playing && generation == request;
    Psyz_AudioUnlock();
    if (continue_disc)
        play_sector(sector);
}

void WebMusicInitialize(void)
{
    emscripten_set_interval(poll_music, 100, NULL);
}

#ifdef TM4_WEB_TEST_HOOKS
/* Move the source cursor only; playback and the original callback handle the end. */
EMSCRIPTEN_KEEPALIVE int WebTestMusicNearEnd(void)
{
    Psyz_AudioLock();
    int ready = playing && current_track && cached_track == current_track;
    if (ready)
        sample_cursor = sample_count - 1176 * 30;
    Psyz_AudioUnlock();
    return ready;
}
#endif
