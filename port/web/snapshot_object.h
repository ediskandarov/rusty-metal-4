#ifndef TM4_WEB_SNAPSHOT_OBJECT_H
#define TM4_WEB_SNAPSHOT_OBJECT_H

#include "tm4/integer.h"
#include "tm4/main/object.h"

typedef void* WebSnapshotFindObject(u32 handle);

int WebSnapshotExtenderGroupValid(const Tm4ObjectHeader* object);
u32 WebSnapshotLiveHandle(const void* payload);
void* WebSnapshotFindLiveObject(u32 handle);
u32 WebSnapshotObjectCapture(const Tm4ObjectHeader* object, u8* output, u32 capacity);
int WebSnapshotObjectIdentify(const u8* input, u32 length, const char** name, u32* handle);
Tm4ObjectHeader* WebSnapshotObjectAllocate(const u8* input, u32 length);
int WebSnapshotObjectBind(
    Tm4ObjectHeader* object, const u8* input, u32 length, WebSnapshotFindObject* find_object);

#endif
