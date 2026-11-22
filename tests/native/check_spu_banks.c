#include "libspu_private.h"
#include "spu_banks.h"
#include <assert.h>
#include <limits.h>
#include <psyz.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

enum { Frames = 4096, SampleOffset = 0x2400, Voice = 1 };
static union SpuUnion registers;
union SpuUnion* _spu_RXX = &registers;
static u8 bank[PSYZ_SPU_RAM_SIZE];
static short reference[Frames * 2], actual[Frames * 2], continuation[Frames * 2];
static int locked;

/* The test pulls stereo PCM synchronously and supplies no CD audio. */
void Psyz_AudioLock(void)
{
    assert(!locked);
    locked = 1;
}
void Psyz_AudioUnlock(void)
{
    assert(locked);
    locked = 0;
}
size_t Psyz_CdPullSamples(short* out, size_t count)
{
    return 0;
}

static void reset_voice(void)
{
    memset(&registers, 0, sizeof(registers));
    Psyz_SpuReset(0);
    registers.rxx.spucnt = 0xc000;
    registers.rxx.main_vol.left = registers.rxx.main_vol.right = 0x3fff;
    SPU_VOICE_REG* voice = &registers.rxx.voice[Voice];
    voice->volume.left = voice->volume.right = 0x3fff;
    voice->addr = voice->loop_addr = SampleOffset / 8;
    voice->pitch = 0x1000;
    voice->adsr[0] = 0x000f;
    voice->adsr[1] = 0x1fc0;
}

static void play(short* output)
{
    Psyz_SpuWrite(offsetof(SPU_RXX, key_on), 1u << Voice);
    Psyz_SpuPullSamples(output, Frames);
}

static void expect_silence(void)
{
    for (int i = 0; i < Frames * 2; ++i)
        assert(!actual[i]);
}

int main(void)
{
    /* Two distinct ADPCM blocks, with loop start and loop end. */
    u8* sample = bank + SampleOffset;
    sample[0] = sample[16] = 2;
    sample[1] = 4;
    sample[17] = 3;
    memset(sample + 2, 0x3a, 14);
    memset(sample + 18, 0xce, 14);

    reset_voice();
    Psyz_SpuMemWrite(SampleOffset, sample, 32);
    play(reference);
    int audible = 0;
    for (int i = Frames; i < Frames * 2; ++i)
        audible += reference[i] != 0;
    assert(audible > Frames / 2);

    reset_voice();
    WebSpuSetNextVoiceBank(Voice, bank);
    play(actual);
    assert(!memcmp(actual, reference, sizeof(actual)));
    play(actual);
    expect_silence();

    WebSpuSetNextVoiceBank(Voice, bank);
    play(actual);
    WebSpuReleaseVoiceBanks();
    assert(registers.rxx.voice[Voice].volumex == 0);
    Psyz_SpuPullSamples(actual, Frames);
    expect_silence();
    // Releasing extra banks must not stop an ordinary voice already playing.
    reset_voice();
    Psyz_SpuMemWrite(SampleOffset, sample, 32);
    play(reference);
    Psyz_SpuPullSamples(continuation, Frames);
    reset_voice();
    Psyz_SpuMemWrite(SampleOffset, sample, 32);
    registers.rxx.voice[2] = registers.rxx.voice[Voice];
    WebSpuSetNextVoiceBank(2, bank);
    Psyz_SpuWrite(offsetof(SPU_RXX, key_on), (1u << Voice) | (1u << 2));
    Psyz_SpuPullSamples(actual, Frames);
    assert(registers.rxx.voice[2].volumex != 0);
    unsigned short ordinary_env = registers.rxx.voice[Voice].volumex;
    WebSpuReleaseVoiceBanks();
    assert(registers.rxx.voice[2].volumex == 0);
    assert(registers.rxx.voice[Voice].volumex == ordinary_env);
    Psyz_SpuPullSamples(actual, Frames);
    assert(!memcmp(actual, continuation, sizeof(actual)));

    // Pending selections must not retain freed memory; invalid IDs cannot corrupt neighbours.
    reset_voice();
    Psyz_SpuMemWrite(SampleOffset, sample, 32);
    u8* temporary = malloc(PSYZ_SPU_RAM_SIZE);
    assert(temporary);
    memcpy(temporary, bank, PSYZ_SPU_RAM_SIZE);
    WebSpuSetNextVoiceBank(Voice, temporary);
    WebSpuReleaseVoiceBanks();
    free(temporary);
    WebSpuSetNextVoiceBank(-1, bank);
    WebSpuSetNextVoiceBank(PSYZ_SPU_NUM_VOICES, bank);
    WebSpuSetNextVoiceBank(INT_MAX, bank);
    play(actual);
    assert(!memcmp(actual, reference, sizeof(actual)));
    WebSpuReleaseVoiceBanks();
    WebSpuReleaseVoiceBanks();
    reset_voice();
    registers.rxx.voice[23] = registers.rxx.voice[Voice];
    WebSpuSetNextVoiceBank(23, bank);
    Psyz_SpuWrite(offsetof(SPU_RXX, key_on[1]), 1u << 7);
    Psyz_SpuPullSamples(actual, Frames);
    assert(!memcmp(actual, reference, sizeof(actual)));
    WebSpuReleaseVoiceBanks();
    assert(registers.rxx.voice[23].volumex == 0 && !locked);
    puts("PASS bank PCM, ordinary voice preservation, pending release and voice bounds");
    return 0;
}
