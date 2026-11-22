/* Real sound registry and bank allocator, with the SPU/device boundary supplied here. */
#define VSync TestVSync
#define WebSpuSetNextVoiceBank TestSetNextVoiceBank
#define WebSpuReleaseVoiceBanks TestReleaseVoiceBanks
#include "port/psyz/sdk.h"
#include "src/main/sound.c"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned bank_allocations, bank_frees;
static int fail_bank, detached;
static void* allocate_bank(size_t count, size_t bytes)
{
    if (fail_bank)
        return NULL;
    void* allocation = calloc(count, bytes);
    if (allocation) {
        ++bank_allocations;
        detached = 0;
    }
    return allocation;
}
static void release_bank(void* allocation)
{
    assert(allocation && detached);
    ++bank_frees;
    free(allocation);
}
#define calloc allocate_bank
#define free release_bank
#include "port/game/sound_samples.c"
#undef calloc
#undef free

static int fail_table, fail_transfer;
static unsigned transfers, reports, key_calls, releases;
static const u8* selected_bank;
static SpuVoiceAttr started;
static u8 spu_ram[PSYZ_SPU_RAM_SIZE], input[PSYZ_SPU_RAM_SIZE];
static unsigned transfer_address;
void* MemAlloc(u32 bytes)
{
    return malloc(bytes);
}
void* MemRealloc(void* allocation, u32 bytes)
{
    return fail_table ? NULL : realloc(allocation, bytes);
}
void MemFree(void* allocation)
{
    free(allocation);
}
int WebNetMatchActive(void)
{
    return 0;
}
void WebRollbackAudioReportVoiceStart(void)
{
    ++reports;
}
void WebSpuSetNextVoiceBank(int voice, const u8* bank)
{
    selected_bank = bank;
}
void WebSpuReleaseVoiceBanks(void)
{
    // The allocation owner must detach the mixer before freeing its banks.
    detached = 1;
    selected_bank = NULL;
    ++releases;
}
long SpuSetTransferMode(long mode)
{
    return mode;
}
unsigned long SpuSetTransferStartAddr(unsigned long address)
{
    transfer_address = address;
    return address;
}
u_long SpuWrite(u_char* data, u_long size)
{
    assert(transfer_address + size <= sizeof(spu_ram));
    if (fail_transfer)
        return size - 8;
    memcpy(spu_ram + transfer_address, data, size);
    ++transfers;
    return size;
}
long SpuIsTransferCompleted(long mode)
{
    return 1;
}
int VSync(int mode)
{
    assert(!"synchronous uploads must not wait for presentation");
    return 0;
}
void SpuSetKey(long on_off, unsigned long mask)
{
    ++key_calls;
}
void SpuSetKeyOnWithAttr(SpuVoiceAttr* attr)
{
    started = *attr;
}

static void attach(s32 program, s32 sample)
{
    assert(SoundAddAttribute(program, sample, 127, 64, 60, 0, 0, 0, 0xf, 0x1fc0));
}
int main(void)
{
    memset(input, 0x55, sizeof(input));
    assert(SoundUploadSample(NULL, 16) == -1);
    assert(SoundUploadSample(input, 8) == -1);
    assert(SoundUploadSample(input, 17) == -1);
    assert(SoundUploadSample(input, sizeof(input) + 8) == -1);
    fail_transfer = 1;
    assert(SoundUploadSample(input, 16) == -1 && !SoundSampleCount);
    fail_transfer = 0;
    assert(SoundUploadSample(input, PSYZ_SPU_RAM_SIZE - 0x1010) == 0);
    assert(transfers == 1 && !SoundSamples[0].bank && SoundSamples[0].address == 0x1010);
    fail_bank = 1;
    assert(SoundUploadSample(input, 32) == -1 && SoundSampleCount == 1);
    fail_bank = 0;
    fail_table = 1;
    assert(SoundUploadSample(input, 32) == -1 && bank_allocations == 0);
    fail_table = 0;
    assert(SoundUploadSample(input, 32) == 1);
    const u8* first = SoundSamples[1].bank;
    assert(first && SoundSamples[1].address == 0 && !memcmp(first, input, 32));
    assert(SoundUploadSample(input, PSYZ_SPU_RAM_SIZE - 32) == 2);
    assert(SoundSamples[2].bank == first && SoundSamples[2].address == 32);
    assert(SoundUploadSample(input, 32) == 3);
    assert(SoundSamples[3].bank != first && SoundSamples[3].address == 0);
    for (int i = 4; i <= 256; ++i)
        assert(SoundUploadSample(input, 16) == i);
    int program = SoundAddProgram("bank-boundary");
    assert(program >= 0);
    assert(!SoundAddAttribute(-1, 0, 0, 0, 0, 0, 0, 0, 0, 0));
    assert(!SoundAddAttribute(program, -1, 0, 0, 0, 0, 0, 0, 0, 0));
    assert(!SoundAddAttribute(program, SoundSampleCount, 0, 0, 0, 0, 0, 0, 0, 0));
    attach(program, 0);
    attach(program, 256);
    SoundStartVoice(program, 1, 0, 23, 0x1000, 100, 100);
    assert(selected_bank == SoundSamples[256].bank && started.addr == SoundSamples[256].address);
    assert(SoundPrograms[program].attributes[1].sample == 256);
    SoundStartVoice(program, 0, 0, 23, 0x1000, 100, 100);
    assert(!selected_bank && started.addr == 0x1010);
    unsigned previous = key_calls;
    SoundStartVoice(program, 1, 0, 24, 0x1000, 100, 100);
    SoundStartVoice(-1, 0, 0, 0, 0x1000, 100, 100);
    SoundStartVoice(program, -1, 0, 0, 0x1000, 100, 100);
    assert(key_calls == previous && reports == 2);
    int count = SoundSampleCount;
    SoundSampleCount = 0xffff;
    assert(SoundUploadSample(input, 16) == -1);
    SoundSampleCount = count;
    SoundDestructor();
    assert(bank_allocations == bank_frees && releases == 1 && !SoundSampleCount && !SoundSamples);
    SoundDestructor();
    assert(releases == 2);
    assert(SoundUploadSample(input, 16) == 0);
    assert(!SoundSamples[0].bank && SoundSamples[0].address == 0x1010 && transfers == 2);
    SoundDestructor();
    puts("PASS sound bank boundaries, allocation failure, sample 256, voice reuse and teardown");
    return 0;
}
