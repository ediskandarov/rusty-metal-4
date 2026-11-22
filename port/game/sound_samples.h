#ifndef RM4_SOUND_SAMPLES_H
#define RM4_SOUND_SAMPLES_H
#include "tm4_scalar.h"

/* Resource storage, shared by maps and cars. Ordinary SPU RAM is filled first;
 * overflow uses immutable 512 KiB banks. Locations live until the sound teardown. */
int WebSoundSampleStore(const u8* data, s32 size, unsigned long* address, const u8** bank);
/* Detach the audio thread before releasing any bank memory. */
void WebSoundSamplesReset(void);
#endif
