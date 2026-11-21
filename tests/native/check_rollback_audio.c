/* Exercise production rollback audio without an audio device or disc assets. */
#include "port/web/net_match.h"
#include "port/web/rollback_audio.h"
#include "tm4/main/main.h"
#include "tm4/main/object.h"
#include "tm4/main/sound.h"
#include <assert.h>
#include <emscripten.h>
#include <stdio.h>
#include <string.h>

Tm4ObjectList ObjectLists[OBJECT_LIST_COUNT];
s32 MainFrameCount;
static int predicting, replaying;
static unsigned stopped;

int WebNetRenderedPrediction(void) { return predicting; }
int WebNetReplaying(void) { return replaying; }
void SoundStopSound(s32 voice) { stopped |= 1u << voice; }

typedef struct {
    Tm4ObjectHeader header;
    SoundEmitter emitter;
} TestEmitter;

static TestEmitter first, second;
static SoundEmitterVoice voices[4];

static void reset(void)
{
    memset(&first, 0, sizeof(first));
    memset(&second, 0, sizeof(second));
    memset(voices, 0, sizeof(voices));
    first.header.serial = 1;
    second.header.serial = 2;
    first.header.next = &second.header;
    first.emitter.voices = voices;
    first.emitter.voice_count = 3;
    first.emitter.program_id = 10;
    second.emitter.voices = &voices[3];
    second.emitter.voice_count = 1;
    second.emitter.program_id = 20;
    for (int i = 0; i < 4; ++i) {
        voices[i].attribute_index = i;
        voices[i].voice_id = SOUND_VOICE_UNASSIGNED;
    }
    ObjectLists[OBJECT_LIST_SOUND].first = &first.header;
    MainFrameCount = 100;
    stopped = 0;
    WebRollbackAudioReset();
    WebRollbackAudioRemember();
    EM_ASM({ globalThis.tm4Port = {}; });
}

int main(void)
{
    reset();
    voices[0].duration_frames = 0;
    voices[1].duration_frames = 20;
    voices[1].voice_id = 4;
    voices[2].duration_frames = -1;
    voices[2].voice_id = 5;
    voices[3].duration_frames = -1;
    WebRollbackAudioSuppressReplay();
    assert(voices[0].voice_id == WebAudioPlaybackFinished);
    assert(voices[1].voice_id == WebAudioPlaybackFinished);
    assert(voices[2].voice_id == 5);
    assert(voices[3].voice_id == SOUND_VOICE_UNASSIGNED);
    assert(stopped == 0);

    /* Rollback reuses audible loops and one-shots, and stops vanished voices. */
    reset();
    voices[0].duration_frames = 20;
    voices[0].voice_id = 3;
    voices[1].duration_frames = -1;
    voices[1].voice_id = 4;
    voices[2].duration_frames = -1;
    voices[2].voice_id = 5;
    WebRollbackAudioRemember();
    WebRollbackAudioDetach();
    assert(voices[0].voice_id == WebAudioPlaybackFinished);
    assert(voices[1].voice_id == SOUND_VOICE_UNASSIGNED);
    assert(voices[2].voice_id == SOUND_VOICE_UNASSIGNED);
    first.emitter.voice_count = 2;
    WebRollbackAudioReconcile();
    assert(voices[0].voice_id == 3 && voices[1].voice_id == 4);
    assert(stopped == (1u << 5));
    assert(EM_ASM_INT({ return tm4Port.rollbackVoicesReused; }) == 2);
    assert(EM_ASM_INT({ return tm4Port.rollbackVoicesStopped; }) == 1);

    /* A heard one-shot that finished before rollback must not start again. */
    reset();
    first.emitter.voice_count = 2;
    second.emitter.voice_count = 0;
    voices[0].duration_frames = 20;
    voices[1].duration_frames = -1;
    WebRollbackAudioStarted(&first.emitter, 0);
    WebRollbackAudioStarted(&first.emitter, 1);
    ++MainFrameCount;
    WebRollbackAudioRemember();
    WebRollbackAudioReconcile();
    assert(voices[0].voice_id == WebAudioPlaybackFinished);
    assert(voices[1].voice_id == SOUND_VOICE_UNASSIGNED);
    assert(EM_ASM_INT({ return tm4Port.rollbackVoicesSuppressed; }) == 1);
    voices[0].voice_id = SOUND_VOICE_UNASSIGNED;
    ++first.header.serial;
    WebRollbackAudioReconcile();
    assert(voices[0].voice_id == SOUND_VOICE_UNASSIGNED);
    --first.header.serial;
    WebRollbackAudioReset();
    WebRollbackAudioReconcile();
    assert(voices[0].voice_id == SOUND_VOICE_UNASSIGNED);

    /* Diagnostic counters keep their browser-visible names and gating. */
    predicting = 0;
    replaying = 1;
    WebRollbackAudioReportVoiceStart();
    assert(EM_ASM_INT({ return tm4Port.predictionSoundStarts || 0; }) == 0);
    predicting = 1;
    replaying = 0;
    WebRollbackAudioReportVoiceStart();
    assert(EM_ASM_INT({ return tm4Port.predictionSoundStarts; }) == 1);
    assert(EM_ASM_INT({ return tm4Port.predictionReplaySoundStarts || 0; }) == 0);
    replaying = 1;
    WebRollbackAudioReportVoiceStart();
    assert(EM_ASM_INT({ return tm4Port.predictionSoundStarts; }) == 2);
    assert(EM_ASM_INT({ return tm4Port.predictionReplaySoundStarts; }) == 1);
    puts("PASS: rollback audio suppression, loops, reconciliation and diagnostics");
    return 0;
}
