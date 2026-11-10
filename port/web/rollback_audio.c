#include "rollback_audio.h"
#include "checkpoint.h"
#include "net_match.h"
#include "tm4/main/main.h"
#include "tm4/main/object.h"
#include "tm4/main/sound.h"
#include <emscripten.h>
#include <string.h>

enum {
    VoiceCount = 24,
    HeardCount = VoiceCount * (WebCheckpointHistoryTicks + 1)
};

typedef struct {
    u32 serial;
    u32 born;
    s32 program;
    s32 attribute;
    int active;
} Voice;

static Voice audible[VoiceCount];
static Voice heard[HeardCount];
static unsigned next_heard;

void WebRollbackAudioReset(void)
{
    memset(heard, 0, sizeof(heard));
    next_heard = 0;
}

static Voice voice_key(const Tm4ObjectHeader* object, const SoundEmitter* emitter, s32 index, u32 tick)
{
    const SoundEmitterVoice* voice = &emitter->voices[index];
    return (Voice) {
        .serial = object->serial,
        .born = tick - emitter->age_frames,
        .program = emitter->program_id,
        .attribute = voice->attribute_index,
        .active = 1,
    };
}

static int same_voice(const Voice* a, const Voice* b)
{
    return a->active && a->serial == b->serial && a->born == b->born && a->program == b->program
        && a->attribute == b->attribute;
}

void WebRollbackAudioStarted(const SoundEmitter* emitter, int index)
{
    const SoundEmitterVoice* voice = &emitter->voices[index];
#ifdef TM4_WEB_TEST_HOOKS
    EM_ASM({
        tm4Port.testMixerStarts?.push([ $0, $1, $2, $3, $4, $5 ]);
    }, ObjectGetHeader(emitter)->serial, voice->attribute_index, voice->voice_id,
        voice->duration_frames, (u32)MainFrameCount + 1, WebNetReplaying());
#endif
    if (voice->duration_frames >= 0) {
        heard[next_heard] = voice_key(ObjectGetHeader(emitter), emitter, index,
            (u32)MainFrameCount + 1);
        next_heard = (next_heard + 1) % HeardCount;
    }
}

void WebRollbackAudioRemember(void)
{
    memset(audible, 0, sizeof(audible));
    for (const Tm4ObjectHeader* object = ObjectLists[OBJECT_LIST_SOUND].first; object;
         object = object->next) {
        const SoundEmitter* emitter = ObjectGetPayload(object);
        for (s32 i = 0; i < emitter->voice_count; ++i) {
            const s32 id = emitter->voices[i].voice_id;
            if (id >= 0 && id < VoiceCount)
                audible[id] = voice_key(object, emitter, i, MainFrameCount);
        }
    }
}

void WebRollbackAudioDetach(void)
{
    for (Tm4ObjectHeader* object = ObjectLists[OBJECT_LIST_SOUND].first; object;
         object = object->next) {
        SoundEmitter* emitter = ObjectGetPayload(object);
        for (s32 i = 0; i < emitter->voice_count; ++i) {
            SoundEmitterVoice* voice = &emitter->voices[i];
            if (voice->voice_id >= 0)
                voice->voice_id = voice->duration_frames >= 0 ? WebAudioPlaybackFinished
                                                            : SOUND_VOICE_UNASSIGNED;
        }
    }
}

void WebRollbackAudioReconcile(void)
{
    unsigned reused = 0, stopped = 0, suppressed = 0;
    for (Tm4ObjectHeader* object = ObjectLists[OBJECT_LIST_SOUND].first; object;
         object = object->next) {
        SoundEmitter* emitter = ObjectGetPayload(object);
        for (s32 i = 0; i < emitter->voice_count; ++i) {
            const Voice current = voice_key(object, emitter, i, MainFrameCount);
            for (s32 id = 0; id < VoiceCount; ++id) {
                Voice* previous = &audible[id];
                if (same_voice(previous, &current)) {
                    emitter->voices[i].voice_id = id;
                    previous->active = 0;
                    ++reused;
                    break;
                }
            }
            SoundEmitterVoice* voice = &emitter->voices[i];
            if (voice->voice_id != SOUND_VOICE_UNASSIGNED || voice->duration_frames < 0)
                continue;
            for (unsigned j = 0; j < HeardCount; ++j) {
                if (same_voice(&heard[j], &current)) {
                    voice->voice_id = WebAudioPlaybackFinished;
                    ++suppressed;
                    break;
                }
            }
        }
    }
    for (s32 id = 0; id < VoiceCount; ++id) {
        if (audible[id].active) {
            SoundStopSound(id);
            ++stopped;
        }
    }
    EM_ASM(
        {
            tm4Port.rollbackVoicesReused = (tm4Port.rollbackVoicesReused || 0) + $0;
            tm4Port.rollbackVoicesStopped = (tm4Port.rollbackVoicesStopped || 0) + $1;
            tm4Port.rollbackVoicesSuppressed = (tm4Port.rollbackVoicesSuppressed || 0) + $2;
        },
        reused, stopped, suppressed);
}
