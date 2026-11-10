#ifndef TM4_WEB_CHECKPOINT_MEMORY_H
#define TM4_WEB_CHECKPOINT_MEMORY_H

#include "tm4/integer.h"

enum { WEB_CHECKPOINT_ARENA_BYTES = 4 * 1024 * 1024 };

int WebCheckpointArenaOpen(void);
void WebCheckpointArenaSelect(int active);
void WebCheckpointArenaClose(void);
int WebCheckpointResourceSpan(const void* address, u32 size);
u32 WebCheckpointArenaCapture(u8* output, u32 capacity);
int WebCheckpointArenaRestore(const u8* input, u32 length);

#endif
