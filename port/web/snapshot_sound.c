#include "snapshot_types.h"
#include "tm4/main/sound.h"

#include "rollback_audio.h"

enum { MaxEmitterVoices = 32 };

char* SoundGetProgramName(s32 program);

static const char* program_name(s32 id) { return id < 0 ? NULL : SoundGetProgramName(id); }

static const SnapshotNumericBinding program_keys = { program_name, SoundGetProgramId };

static const SnapshotField voice_fields[] = {
    SNAP_POD(SoundEmitterVoice, attribute_index),
    SNAP_TRANSIENT(SoundEmitterVoice, voice_id),
    SNAP_POD(SoundEmitterVoice, duration_frames),
    SNAP_POD(SoundEmitterVoice, pitch),
    SNAP_POD(SoundEmitterVoice, pitch_delta),
    SNAP_POD(SoundEmitterVoice, pitch_mode),
    SNAP_POD(SoundEmitterVoice, pan),
    SNAP_POD(SoundEmitterVoice, volume),
    SNAP_POD(SoundEmitterVoice, fade_per_frame),
    SNAP_POD(SoundEmitterVoice, pitch_base),
    SNAP_POD(SoundEmitterVoice, volume_base),
    { 0 },
};

static u32 voice_count(const void* payload) { return ((const SoundEmitter*)payload)->voice_count; }

static const SnapshotArray voices = {
    voice_fields,
    sizeof(SoundEmitterVoice),
    voice_count,
    MaxEmitterVoices,
};

static const SnapshotField emitter_fields[] = {
    SNAP_POD(SoundEmitter, flags),
    SNAP_POD(SoundEmitter, previous_position.vx),
    SNAP_POD(SoundEmitter, previous_position.vy),
    SNAP_POD(SoundEmitter, previous_position.vz),
    SNAP_TRANSIENT(SoundEmitter, previous_position.pad),
    SNAP_POD(SoundEmitter, position.vx),
    SNAP_POD(SoundEmitter, position.vy),
    SNAP_POD(SoundEmitter, position.vz),
    SNAP_TRANSIENT(SoundEmitter, position.pad),
    SNAP_POD(SoundEmitter, velocity.vx),
    SNAP_POD(SoundEmitter, velocity.vy),
    SNAP_POD(SoundEmitter, velocity.vz),
    SNAP_TRANSIENT(SoundEmitter, velocity.pad),
    SNAP_POD(SoundEmitter, age_frames),
    SNAP_NUMERIC_KEY(SoundEmitter, program_id, &program_keys),
    SNAP_POD(SoundEmitter, voice_count),
    SNAP_OWNED_ARRAY(SoundEmitter, voices, &voices),
    { 0 },
};

static int emitter_valid(const void* payload)
{
    const SoundEmitter* emitter = payload;
    if (emitter->program_id < 0 || emitter->voice_count <= 0
        || emitter->voice_count > MaxEmitterVoices || !emitter->voices || emitter->age_frames < -1
        || emitter->flags < 0 || emitter->flags >= SOUND_EMITTER_FLAG_LIMIT)
        return 0;
    const s32 attributes = SoundProgramIdGetNumVagAttrs(emitter->program_id);
    if (emitter->voice_count > attributes)
        return 0;
    for (s32 i = 0; i < emitter->voice_count; ++i) {
        const SoundEmitterVoice* voice = &emitter->voices[i];
        SoundVagAttr attribute;
        if (voice->attribute_index < 0 || voice->attribute_index >= attributes
            || !SoundProgramIdGetVagAttr(emitter->program_id, voice->attribute_index, &attribute)
            || voice->duration_frames < -1 || (voice->duration_frames == -1) != !!attribute.loop
            || voice->pitch_mode < SOUND_PITCH_FIXED || voice->pitch_mode > SOUND_PITCH_SCALED
            || voice->pitch <= 0 || voice->pitch > 0x4000 || voice->pan < 0 || voice->pan > 127)
            return 0;
    }
    return 1;
}

static int restore_voice_playback(
    void* payload, const u8* input, u32 length, WebSnapshotFindObject* find)
{
    SoundEmitter* emitter = payload;
    if (length)
        return 0;
    for (s32 i = 0; i < emitter->voice_count; ++i) {
        SoundEmitterVoice* voice = &emitter->voices[i];
        voice->voice_id
            = voice->duration_frames < 0 ? SOUND_VOICE_UNASSIGNED : WebAudioPlaybackFinished;
    }
    return 1;
}

const SnapshotType WebSnapshotSoundTypes[] = {
    { "soundEmitter", sizeof(SoundEmitter), emitter_fields, emitter_valid, NULL,
        restore_voice_playback, .baseline_removable = 1 },
    { 0 },
};
