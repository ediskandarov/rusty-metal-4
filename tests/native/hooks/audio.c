#include "pending.h"
#include "port/web/checkpoint_memory.h"
#include "port/web/rollback_audio.h"
#include "port/web/snapshot_types.h"
#include "tm4/main/object.h"
#include "tm4/main/sound.h"
#include <emscripten.h>
#include <libsnd.h>
#include <libspu.h>
#include <stdlib.h>
#include <string.h>

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

/* Counts emitter voice records, including pending playback; not hardware activity. */
EMSCRIPTEN_KEEPALIVE int WebTestCountSoundVoices(char* name, s32 pitch, int attached)
{
    s32 program = SoundGetProgramId(name);
    int count = 0;
    for (Tm4ObjectHeader* h = ObjectLists[OBJECT_LIST_SOUND].first; h; h = h->next) {
        SoundEmitter* e = ObjectGetPayload(h);
        if (e->program_id != program || (!!h->owner) != attached)
            continue;
        for (s32 i = 0; i < e->voice_count; ++i)
            if (e->voices[i].pitch == pitch)
                ++count;
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

/* Load actual VABs large enough to move the fixture beyond ordinary SPU RAM. */
EMSCRIPTEN_KEEPALIVE int WebTestPrepareBankedRollbackAudio(void)
{
    const char* names[] = { "bankPadding", "bankFiniteA", "bankFiniteB", "bankLoop" };
    WebCheckpointArenaSelect(0);
    for (unsigned i = 0; i < ArrayCount(names); ++i) {
        unsigned sample_bytes = i ? 4096 : 0x7fff0;
        unsigned header_bytes = sizeof(VabHdr) + 128 * sizeof(ProgAtr) + 16 * sizeof(VagAtr) + 512;
        u8* bytes = calloc(1, header_bytes + sample_bytes + strlen(names[i]) + 2);
        if (!bytes)
            return 0;
        VabHdr* vab = (VabHdr*)bytes;
        vab->ps = vab->vs = 1;
        vab->mvol = 127;
        ProgAtr* program = (ProgAtr*)(vab + 1);
        program->tones = 1;
        program->mvol = 127;
        VagAtr* tone = (VagAtr*)(program + 128);
        tone->vol = 127;
        tone->pan = 64;
        tone->center = 60;
        tone->vag = 1;
        tone->adsr1 = 0x000f;
        tone->adsr2 = 0x1fc0;
        u16* sizes = (u16*)(tone + 16);
        sizes[1] = sample_bytes / 8;
        u8* sample = bytes + header_bytes;
        for (unsigned block = 0; block < sample_bytes; block += 16) {
            sample[block] = 2;
            memset(sample + block + 2, 0x3a, 14);
        }
        if (i == 3) {
            sample[1] = 4;
            sample[sample_bytes - 15] = 3;
        } else {
            sample[sample_bytes - 15] = 7;
            memset(sample + sample_bytes - 14, 0x77, 14);
        }
        memcpy(sample + sample_bytes, names[i], strlen(names[i]));
        sample[sample_bytes + strlen(names[i])] = '\n';
        SoundConstructor(vab);
        free(bytes);
        if (SoundGetProgramId((char*)names[i]) < 0)
            return 0;
    }
    return 1;
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
    char* ordinary[] = { "machineGun", "carLanding", "frozenLoop" };
    char* banked[] = { "bankFiniteA", "bankFiniteB", "bankLoop" };
    char** programs = test_audio_pending & 8 ? banked : ordinary;
    EM_ASM({ tm4Port.testAudioSerials = []; });
    for (unsigned i = 0; i < ArrayCount(ordinary); ++i) {
        void* emitter = test_audio_pending & (1 << i)
            ? ObjectCreate("soundEmitter", 0, programs[i], 0)
            : NULL;
        EM_ASM(
            { tm4Port.testAudioSerials.push($0); },
            emitter ? ObjectGetHeader(emitter)->serial : -1);
    }
    test_audio_pending = 0;
}
