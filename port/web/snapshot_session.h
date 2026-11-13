#ifndef TM4_WEB_SNAPSHOT_SESSION_H
#define TM4_WEB_SNAPSHOT_SESSION_H

#include "snapshot_object.h"

int WebSnapshotSessionPrepare(const u8* input, u32 length);
u32 WebSnapshotSessionCapture(u8* output, u32 capacity);
int WebSnapshotSessionRestore(const u8* input, u32 length, WebSnapshotFindObject* find_object);

#endif
