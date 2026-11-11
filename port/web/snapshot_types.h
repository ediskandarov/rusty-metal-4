#ifndef TM4_WEB_SNAPSHOT_TYPES_H
#define TM4_WEB_SNAPSHOT_TYPES_H

#include "snapshot_fields.h"

void WebSnapshotRegisterClass(s32 index, const char* name, size_t size);
const SnapshotType* WebSnapshotObjectType(const Tm4ObjectHeader* object);
const SnapshotType* WebSnapshotTypeByName(const char* name);

extern const SnapshotType WebSnapshotSceneTypes[];
extern const SnapshotType WebSnapshotYardTypes[];
extern const SnapshotType WebSnapshotMovingWorldTypes[];
extern const SnapshotType WebSnapshotEffectTypes[];
extern const SnapshotType WebSnapshotProjectileTypes[];
struct Car;
const SnapshotType* WebSnapshotCarCallbackType(const struct Car* car);
extern const SnapshotType WebSnapshotCarTypes[];
extern const SnapshotType WebSnapshotSoundTypes[];

extern const SnapshotList WebSnapshotInteractionHistory;

#endif
