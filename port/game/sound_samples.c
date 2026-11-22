#include "sound_samples.h"
#include "port/psyz/spu_banks.h"
#include <libspu.h>
#include <psyz.h>
#include <stdlib.h>
#include <string.h>

typedef struct SampleBank {
    struct SampleBank* next;
    u8 samples[PSYZ_SPU_RAM_SIZE];
} SampleBank;

/* The original reserves the low SPU addresses for capture and system data. */
enum { FirstSampleAddress = 0x1010 };
static SampleBank* banks;
static unsigned cursor = FirstSampleAddress;

int WebSoundSampleStore(const u8* data, s32 size, unsigned long* address, const u8** bank)
{
    if (!data || !address || !bank || size < 16 || size > PSYZ_SPU_RAM_SIZE || (size & 7))
        return 0;
    SampleBank* destination = banks;
    unsigned offset = cursor;
    if ((unsigned)size > PSYZ_SPU_RAM_SIZE - offset) {
        destination = calloc(1, sizeof(*destination));
        if (!destination)
            return 0;
        destination->next = banks;
        offset = 0;
    }
    if (destination) {
        memcpy(destination->samples + offset, data, size);
    } else {
        SpuSetTransferMode(SPU_TRANSFER_BY_DMA);
        SpuSetTransferStartAddr(offset);
        if (SpuWrite((u8*)data, size) != (unsigned)size)
            return 0;
    }
    banks = destination;
    cursor = offset + size;
    *address = offset;
    *bank = destination ? destination->samples : NULL;
    return 1;
}

void WebSoundSamplesReset(void)
{
    WebSpuReleaseVoiceBanks();
    while (banks) {
        SampleBank* next = banks->next;
        free(banks);
        banks = next;
    }
    cursor = FirstSampleAddress;
}
