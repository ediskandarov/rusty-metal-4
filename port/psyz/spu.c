#include <libspu.h>

void SpuSetKeyOnWithAttr(SpuVoiceAttr* attributes)
{
    SpuSetVoiceAttr(attributes);
    SpuSetKey(SPU_ON, attributes->voice);
}

void SpuSetCommonMasterVolume(short left, short right)
{
    SpuCommonAttr attributes
        = { .mask = SPU_COMMON_MVOLL | SPU_COMMON_MVOLR, .mvol = { left, right } };
    SpuSetCommonAttr(&attributes);
}

void SpuSetCommonCDVolume(short left, short right)
{
    SpuCommonAttr attributes
        = { .mask = SPU_COMMON_CDVOLL | SPU_COMMON_CDVOLR, .cd.volume = { left, right } };
    SpuSetCommonAttr(&attributes);
}

void SpuSetCommonCDMix(long enabled)
{
    SpuCommonAttr attributes = { .mask = SPU_COMMON_CDMIX, .cd.mix = enabled };
    SpuSetCommonAttr(&attributes);
}
