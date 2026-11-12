#include "snapshot_types.h"
#include "net_match.h"

#include "src/main/object/private.h"
#include "src/modules/car/private.h"

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

static WebObjectDestruction* destroying;

static int is_destroying(const void* object)
{
    for (const WebObjectDestruction* scope = destroying; scope; scope = scope->previous)
        if (scope->object == object)
            return 1;
    return 0;
}

void WebSnapshotBeginDestruction(WebObjectDestruction* scope, const void* object)
{
    scope->object = WebNetMatchActive() ? object : NULL;
    scope->previous = destroying;
    if (scope->object)
        destroying = scope;
}

void WebSnapshotEndDestruction(WebObjectDestruction* scope)
{
    if (!scope->object)
        return;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next) {
            void* object = ObjectGetPayload(header);
            /* Nested destruction must not inspect a parent's partially freed fields. */
            if (is_destroying(object))
                continue;
            WebSnapshotForgetWeakReferences(WebSnapshotObjectType(header), object, scope->object);
            if (!strcmp(header->name, "car")) {
                Car* car = object;
                WebSnapshotForgetWeakReferences(WebSnapshotCarCallbackType(car),
                    car->callback_context, scope->object);
            }
        }
    }
    destroying = scope->previous;
}
