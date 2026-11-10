#include "snapshot_object.h"

#include "snapshot_types.h"

#include "src/main/object/private.h"

#include <stdint.h>
#include <string.h>

enum { ObjectVersion = 1 };

typedef struct {
    u32 version;
    char class_name[OBJECT_CLASS_NAME_CAPACITY];
    u32 serial;
    u32 previous, next, next_display, next_interaction, owner, extenders;
    Tm4ShortVectorXYZ position;
    s16 interaction_radius;
    u8 flags, interaction_enabled, is_interaction_extender, process_mode;
} ObjectRecord;

typedef struct {
    char* name;
    u32 size;
    Tm4ObjectCallback process, alternate_process;
    Tm4ObjectDisplayCallback display;
    Tm4ObjectCallback destructor;
    Tm4ObjectInteractionCallback interact;
    s32 index;
} LocalClass;

u32 WebSnapshotLiveHandle(const void* payload)
{
    if (!payload)
        return 0;
    return ObjectValidObject((void*)payload) ? (u32)ObjectGetHeader(payload)->serial + 1
                                             : UINT32_MAX;
}

void* WebSnapshotFindLiveObject(u32 handle)
{
    for (unsigned i = 0; i < OBJECT_LIST_COUNT; ++i)
        for (Tm4ObjectHeader* object = ObjectLists[i].first; object; object = object->next)
            if ((u32)object->serial + 1 == handle)
                return ObjectGetPayload(object);
    return NULL;
}

static int bind_class(char* name, u8 flags, LocalClass* type)
{
    const SnapshotType* description = WebSnapshotTypeByName(name);
    if (!description || ((flags & OBJECT_CUSTOM_CLASS) != 0) != (description->custom != NULL))
        return 0;
    if (description->custom) {
        const SnapshotCustomClass* custom = description->custom;
        *type = (LocalClass) {
            .name = (char*)description->name,
            .size = description->size,
            .process = custom->process,
            .display = custom->display,
            .destructor = custom->destructor,
            .interact = custom->interact,
            .alternate_process = description->alternate_process,
            .index = -1,
        };
        return 1;
    }
    s32 index = ObjectFindClassIndex(name);
    if (index < 0 || index >= ObjectClassCount)
        return 0;
    const Tm4ObjectClass* descriptor = &ObjectClasses[index];
    if (descriptor->payload_size != description->size)
        return 0;
    *type = (LocalClass) {
        .name = descriptor->name,
        .size = descriptor->payload_size,
        .process = descriptor->process,
        .alternate_process = description->alternate_process,
        .display = descriptor->display,
        .destructor = descriptor->destructor,
        .index = index,
    };
    return 1;
}

static u32 header_handle(const Tm4ObjectHeader* object)
{
    return WebSnapshotLiveHandle(object ? ObjectGetPayload(object) : NULL);
}

u32 WebSnapshotObjectCapture(const Tm4ObjectHeader* object, u8* output, u32 capacity)
{
    LocalClass type;
    if (!object || !output || capacity < sizeof(ObjectRecord)
        || !bind_class(object->name, object->flags, &type) || object->class_index != type.index
        || object->display != type.display || object->destructor != type.destructor
        || object->interact != type.interact)
        return 0;

    ObjectRecord record;
    memset(&record, 0, sizeof(record));
    if (object->process != type.process) {
        if (!type.alternate_process || object->process != type.alternate_process)
            return 0;
        record.process_mode = 1;
    }
    const size_t name_length = strnlen(type.name, sizeof(record.class_name));
    if (name_length == sizeof(record.class_name))
        return 0;
    record.version = ObjectVersion;
    memcpy(record.class_name, type.name, name_length + 1);
    record.serial = object->serial;
    record.previous = header_handle(object->previous);
    record.next = header_handle(object->next);
    if (WorldFindSquare(object->position.vx, object->position.vz)) {
        if (object->display)
            record.next_display = header_handle(object->next_display);
        if (object->interaction_enabled)
            record.next_interaction = header_handle(object->next_interaction);
    }
    record.owner = WebSnapshotLiveHandle(object->owner);
    record.extenders = WebSnapshotLiveHandle(object->interaction_extenders);
    if (record.previous == UINT32_MAX || record.next == UINT32_MAX
        || record.next_display == UINT32_MAX || record.next_interaction == UINT32_MAX
        || record.owner == UINT32_MAX || record.extenders == UINT32_MAX)
        return 0;
    record.position = object->position;
    record.interaction_radius = object->interaction_radius;
    record.flags = object->flags;
    record.interaction_enabled = object->interaction_enabled;
    record.is_interaction_extender = object->is_interaction_extender;
    memcpy(output, &record, sizeof(record));
    return sizeof(record);
}

static int read_object(ObjectRecord* record, const u8* input, u32 length, LocalClass* type)
{
    if (!input || length != sizeof(*record))
        return 0;
    memcpy(record, input, sizeof(*record));
    return record->version == ObjectVersion && record->serial < INT32_MAX
        && memchr(record->class_name, 0, sizeof(record->class_name))
        && !(record->flags & ~(OBJECT_OWNER_FLAGS | OBJECT_CUSTOM_CLASS | OBJECT_FROM_INSTANCE))
        && record->interaction_enabled <= 1 && record->is_interaction_extender <= 1
        && ((record->owner != 0) == !!(record->flags & OBJECT_HAS_OWNER))
        && record->owner != record->serial + 1 && record->previous != record->serial + 1
        && record->next != record->serial + 1 && record->next_display != record->serial + 1
        && record->next_interaction != record->serial + 1 && record->extenders != record->serial + 1
        && bind_class(record->class_name, record->flags, type)
        && record->is_interaction_extender == !strcmp(type->name, OBJECT_INTERACTION_EXTENDER_NAME)
        && (!record->process_mode || (record->process_mode == 1 && type->alternate_process));
}

int WebSnapshotObjectIdentify(const u8* input, u32 length, const char** name, u32* handle)
{
    LocalClass type;
    ObjectRecord record;
    if (!read_object(&record, input, length, &type))
        return 0;
    *name = type.name;
    *handle = record.serial + 1;
    return 1;
}

Tm4ObjectHeader* WebSnapshotObjectAllocate(const u8* input, u32 length)
{
    LocalClass type;
    ObjectRecord record;
    if (!read_object(&record, input, length, &type))
        return NULL;
    Tm4ObjectHeader* object = MemCalloc(1, sizeof(*object) + type.size);
    if (!object)
        return NULL;
    object->name = type.name;
    if (type.index == -1) {
        const size_t length = strlen(type.name) + 1;
        object->name = MemAlloc(length);
        if (!object->name) {
            MemFree(object);
            return NULL;
        }
        memcpy(object->name, type.name, length);
    }
    object->serial = record.serial;
    object->class_index = type.index;
    object->process = record.process_mode ? type.alternate_process : type.process;
    object->display = type.display;
    object->destructor = type.destructor;
    object->interact = type.interact;
    object->position = record.position;
    object->interaction_radius = record.interaction_radius;
    object->flags = record.flags;
    object->interaction_enabled = record.interaction_enabled;
    object->is_interaction_extender = record.is_interaction_extender;
    return object;
}

int WebSnapshotObjectBind(
    Tm4ObjectHeader* object, const u8* input, u32 length, WebSnapshotFindObject* find_object)
{
    LocalClass type;
    ObjectRecord record;
    if (!object || !find_object || !read_object(&record, input, length, &type)
        || object->serial != record.serial || object->class_index != type.index)
        return 0;
    void* previous = record.previous ? find_object(record.previous) : NULL;
    void* next = record.next ? find_object(record.next) : NULL;
    void* display = record.next_display ? find_object(record.next_display) : NULL;
    void* interaction = record.next_interaction ? find_object(record.next_interaction) : NULL;
    void* owner = record.owner ? find_object(record.owner) : NULL;
    void* extenders = record.extenders ? find_object(record.extenders) : NULL;
    if ((record.previous && !previous) || (record.next && !next)
        || (record.next_display && !display) || (record.next_interaction && !interaction)
        || (record.owner && !owner)
        || (record.extenders
            && (!extenders || !ObjectGetHeader(extenders)->is_interaction_extender)))
        return 0;
    object->position = record.position;
    object->process = record.process_mode ? type.alternate_process : type.process;
    object->interaction_radius = record.interaction_radius;
    object->flags = record.flags;
    object->interaction_enabled = record.interaction_enabled;
    object->is_interaction_extender = record.is_interaction_extender;
    object->previous = previous ? ObjectGetHeader(previous) : NULL;
    object->next = next ? ObjectGetHeader(next) : NULL;
    object->next_display = display ? ObjectGetHeader(display) : NULL;
    object->next_interaction = interaction ? ObjectGetHeader(interaction) : NULL;
    object->owner = owner;
    object->interaction_extenders = extenders;
    return 1;
}

int WebSnapshotExtenderGroupValid(const Tm4ObjectHeader* object)
{
    const void* payload = ObjectGetPayload(object);
    if (object->interaction_extenders) {
        const Tm4ObjectHeader* root = ObjectGetHeader(object->interaction_extenders);
        if (object->is_interaction_extender || !root->is_interaction_extender
            || root->owner != payload)
            return 0;
    }
    if (!object->is_interaction_extender)
        return 1;
    if (!object->owner || !(object->flags & OBJECT_DESTROY_WITH_OWNER))
        return 0;
    const Tm4ObjectHeader* owner = ObjectGetHeader(object->owner);
    const Tm4InteractionExtender* extender = payload;
    const Tm4InteractionExtender* root = owner->interaction_extenders;
    if (!root || owner->is_interaction_extender || extender->next != root
        || (extender != root && extender->seen))
        return 0;
    for (const Tm4ExtenderSeen* node = extender->seen; node; node = node->next)
        if (!node->object)
            return 0;
    return 1;
}
