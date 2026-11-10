#ifndef TM4_WEB_CHECKPOINT_H
#define TM4_WEB_CHECKPOINT_H

#include "tm4/integer.h"

enum { WebCheckpointHistoryTicks = 12 };

u32 WebCheckpointCapture(u32 tick, int retain_history);
const char* WebCheckpointRestore(u32 tick);
u32 WebCheckpointStorageBytes(void);
void WebCheckpointRejectState(void);
void WebCheckpointDiscard(void);
void WebCheckpointWorldWrite(void* address, u32 size);

#endif
