#pragma once

/* Called by the game thread before key-on. The mixer consumes this selection once.
 * Non-null banks contain 512 KiB of immutable ADPCM memory, owned by the caller. */
void WebSpuSetNextVoiceBank(int voice, const unsigned char* bank);
/* Stop bank-backed voices and clear pending selections under the audio lock.
 * The caller may free all banks after this returns. Ordinary SPU voices survive. */
void WebSpuReleaseVoiceBanks(void);
