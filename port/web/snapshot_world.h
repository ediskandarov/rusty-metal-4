#ifndef TM4_WEB_SNAPSHOT_WORLD_H
#define TM4_WEB_SNAPSHOT_WORLD_H

#include "snapshot_fields.h"

extern const SnapshotIndexBinding WebSnapshotCollisionPolygons;

int WebSnapshotWorldOpen(void);
void WebSnapshotWorldClose(void);
u32 WebSnapshotWorldCapture(u8* output, u32 capacity);
int WebSnapshotWorldReset(WebSnapshotFindObject* find_object);
int WebSnapshotWorldRestore(const u8* input, u32 length, WebSnapshotFindObject* find_object);

#endif
