#include "pending.h"
#include "port/web/checkpoint_memory.h"
#include "port/web/rollback_audio.h"
#include "port/web/snapshot_types.h"
#include "tm4/main/object.h"
#include "tm4/main/sound.h"
#include <emscripten.h>

EMSCRIPTEN_KEEPALIVE int WebTestNetworkPlaybackVoices(void)
{
    int count = 0;
    for (Tm4ObjectHeader* object = ObjectLists[OBJECT_LIST_SOUND].first; object;
         object = object->next) {
        const SoundEmitter* emitter = ObjectGetPayload(object);
        for (s32 i = 0; i < emitter->voice_count; ++i)
            count += emitter->voices[i].voice_id >= 0;
    }
    return count;
}

static SoundEmitter* test_portable_emitter(int loop)
{
    for (Tm4ObjectHeader* object = ObjectLists[OBJECT_LIST_SOUND].first; object;
         object = object->next) {
        SoundEmitter* emitter = ObjectGetPayload(object);
        if (emitter->voice_count > 0 && (emitter->voices[0].duration_frames < 0) == loop)
            return emitter;
    }
    return NULL;
}

EMSCRIPTEN_KEEPALIVE u32 WebTestPortableSoundCapture(int loop)
{
    SoundEmitter* emitter = test_portable_emitter(loop);
    u8 bytes[2048];
    const SnapshotType* type = emitter ? WebSnapshotObjectType(ObjectGetHeader(emitter)) : NULL;
    const u32 length = type ? WebSnapshotFieldsCapture(type, emitter, bytes, sizeof(bytes)) : 0;
    if (length) {
        EM_ASM(
            {
                tm4Port.testPortableSound
                    = ({ bytes : HEAPU8.slice($0, $0 + $1), allocation : $2 });
            },
            bytes, length, emitter->voices);
    }
    return length;
}

EMSCRIPTEN_KEEPALIVE int WebTestPortableSoundPerturb(int loop)
{
    SoundEmitter* emitter = test_portable_emitter(loop);
    if (!emitter)
        return 0;
    emitter->age_frames++;
    emitter->voices[0].volume ^= 1;
    return 1;
}

EMSCRIPTEN_KEEPALIVE int WebTestPortableSoundRestore(int loop)
{
    SoundEmitter* emitter = test_portable_emitter(loop);
    u8 bytes[2048];
    const u32 length = EM_ASM_INT(
        { return (tm4Port.testPortableSound && tm4Port.testPortableSound.bytes.length) || 0; });
    if (!emitter || !length || length > sizeof(bytes))
        return 0;
    EM_ASM({ HEAPU8.set(tm4Port.testPortableSound.bytes, $0); }, bytes);
    SoundEmitter restored = { 0 };
    WebCheckpointArenaSelect(1);
    const SnapshotType* type = WebSnapshotObjectType(ObjectGetHeader(emitter));
    int result = type && WebSnapshotFieldsRestore(type, &restored, bytes, length, NULL);
    if (result) {
        for (s32 i = 0; i < restored.voice_count; ++i) {
            const SoundEmitterVoice* voice = &restored.voices[i];
            const s32 expected
                = voice->duration_frames < 0 ? SOUND_VOICE_UNASSIGNED : WebAudioPlaybackFinished;
            if (voice->voice_id != expected)
                result = 0;
        }
    }
    if (result) {
        WebSnapshotFieldsRelease(type, emitter);
        *emitter = restored;
    } else if (type) {
        WebSnapshotFieldsRelease(type, &restored);
    }
    WebCheckpointArenaSelect(0);
    return result;
}

static unsigned test_audio_pending;

EMSCRIPTEN_KEEPALIVE void WebTestScheduleRollbackAudio(unsigned mask)
{
    test_audio_pending = mask;
}

EMSCRIPTEN_KEEPALIVE unsigned WebTestStopRollbackAudio(s32 serial)
{
    for (Tm4ObjectHeader* header = ObjectLists[OBJECT_LIST_SOUND].first; header;
         header = header->next) {
        if (header->serial != serial)
            continue;
        SoundEmitter* emitter = ObjectGetPayload(header);
        unsigned stopped = 0;
        for (s32 i = 0; i < emitter->voice_count; ++i) {
            if (emitter->voices[i].voice_id >= 0) {
                SoundStopSound(emitter->voices[i].voice_id);
                ++stopped;
            }
        }
        return stopped;
    }
    return 0;
}

void WebTestApplyAudioActions(void)
{
    if (!test_audio_pending)
        return;
    char* programs[] = { "machineGun", "carLanding", "frozenLoop" };
    EM_ASM({ tm4Port.testAudioSerials = []; });
    for (unsigned i = 0; i < ArrayCount(programs); ++i) {
        void* emitter = test_audio_pending & (1 << i)
            ? ObjectCreate("soundEmitter", 0, programs[i], 0)
            : NULL;
        EM_ASM(
            { tm4Port.testAudioSerials.push($0); },
            emitter ? ObjectGetHeader(emitter)->serial : -1);
    }
    test_audio_pending = 0;
}
