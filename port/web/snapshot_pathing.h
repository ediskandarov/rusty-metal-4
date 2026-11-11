#ifndef TM4_WEB_SNAPSHOT_PATHING_H
#define TM4_WEB_SNAPSHOT_PATHING_H

#include "snapshot_types.h"
#include "src/modules/levels/pathing.h"
#include "tm4/main/box.h"

extern const SnapshotGroupFields WebSnapshotPathFields;
int WebSnapshotPathValid(const PathingInfo* path);
u32 WebSnapshotPathCapture(
    const PathingInfo* path, const void* object, u8* output, u32 capacity);
RegistryDirectory* WebSnapshotPathRestore(
    PathingInfo* path, const void* object, const u8* input, u32 length);
int WebSnapshotPathBoxRestore(Box* box, Tm4WorldInfoBundle* world);
void WebSnapshotPathBoxRelease(Box* box);

#endif
