#ifndef TM4_WEB_CHECKPOINT_H
#define TM4_WEB_CHECKPOINT_H

#include "tm4/integer.h"

u32 WebCheckpointCapture(void);
const char* WebCheckpointRestore(void);
void WebCheckpointRejectState(void);
void WebCheckpointDiscard(void);
void WebCheckpointWorldWrite(void* address, u32 size);

#endif
