#include "snapshot_types.h"

#include "src/main/object/private.h"

#include <string.h>

static const SnapshotType* registered[OBJECT_CLASS_LIMIT];

const SnapshotType* WebSnapshotTypeByName(const char* name)
{
    const SnapshotType* groups[] = {
        WebSnapshotSceneTypes,
        WebSnapshotYardTypes,
        WebSnapshotMovingWorldTypes,
        WebSnapshotEffectTypes,
        WebSnapshotProjectileTypes,
        WebSnapshotCarTypes,
        WebSnapshotSoundTypes,
    };
    for (u32 group = 0; group < ArrayCount(groups); ++group)
        for (const SnapshotType* type = groups[group]; type->name; ++type)
            if (!strcmp(type->name, name))
                return type;
    return NULL;
}

void WebSnapshotRegisterClass(s32 index, const char* name, size_t size)
{
    if (index >= 0 && index < OBJECT_CLASS_LIMIT) {
        const SnapshotType* type = WebSnapshotTypeByName(name);
        registered[index] = type && type->size == size ? type : NULL;
    }
}

const SnapshotType* WebSnapshotObjectType(const Tm4ObjectHeader* object)
{
    const s32 index = object->class_index;
    if (index < 0)
        return WebSnapshotTypeByName(object->name);
    return index < OBJECT_CLASS_LIMIT ? registered[index] : NULL;
}
