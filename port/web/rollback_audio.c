#include "rollback_audio.h"
#include "net_match.h"
#include "tm4/main/main.h"
#include "tm4/main/object.h"
#include "tm4/main/sound.h"
#include <emscripten.h>
#include <string.h>

enum { VoiceCount = 24 };

typedef struct {
    u32 serial;
    u32 born;
    s32 program;
    s32 attribute;
    s32 duration;
    s32 index;
    int active;
} Voice;

static Voice audible[VoiceCount];

static Voice voice_key(const Tm4ObjectHeader* object, const SoundEmitter* emitter, s32 index)
{
    const SoundEmitterVoice* voice = &emitter->voices[index];
    return (Voice) {
        .serial = object->serial,
        .born = (u32)MainFrameCount - emitter->age_frames,
        .program = emitter->program_id,
        .attribute = voice->attribute_index,
        .duration = voice->duration_frames,
        .index = index,
        .active = 1,
    };
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
                audible[id] = voice_key(object, emitter, i);
        }
    }
}

void WebRollbackAudioDetach(void)
{
    for (Tm4ObjectHeader* object = ObjectLists[OBJECT_LIST_SOUND].first; object;
         object = object->next) {
        SoundEmitter* emitter = ObjectGetPayload(object);
        for (s32 i = 0; i < emitter->voice_count; ++i)
            emitter->voices[i].voice_id = SOUND_VOICE_UNASSIGNED;
    }
}

void WebRollbackAudioReconcile(void)
{
    // Finite replayed effects are muted. A voice still owned by the same emitter can keep playing.
    WebNetSuppressReplayedSounds();
    unsigned reused = 0, stopped = 0;
    for (Tm4ObjectHeader* object = ObjectLists[OBJECT_LIST_SOUND].first; object;
         object = object->next) {
        SoundEmitter* emitter = ObjectGetPayload(object);
        for (s32 i = 0; i < emitter->voice_count; ++i) {
            const Voice current = voice_key(object, emitter, i);
            for (s32 id = 0; id < VoiceCount; ++id) {
                Voice* previous = &audible[id];
                if (previous->active && previous->serial == current.serial
                    && previous->born == current.born && previous->program == current.program
                    && previous->attribute == current.attribute
                    && previous->duration == current.duration && previous->index == current.index) {
                    emitter->voices[i].voice_id = id;
                    previous->active = 0;
                    ++reused;
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
        },
        reused, stopped);
}
