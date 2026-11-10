#ifndef TM4_WEB_PORTABLE_SNAPSHOT_H
#define TM4_WEB_PORTABLE_SNAPSHOT_H

#include "tm4/integer.h"

enum { WebSnapshotMaxBytes = 256 * 1024 };

u32 WebSnapshotCapture(u8* output, u32 capacity, const char** blocker);
int WebSnapshotRestore(const u8* input, u32 length, const char** blocker);

#endif
