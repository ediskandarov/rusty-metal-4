#include "snapshot_fields.h"

#include "tm4/main/memory.h"

#include <stdint.h>
#include <string.h>

enum { KeyCapacity = 64 };

typedef struct {
    u8* output;
    const u8* input;
    u32 remaining;
    WebSnapshotFindObject* find;
} Cursor;

static int transfer(Cursor* io, void* value, size_t size)
{
    if (size > io->remaining)
        return 0;
    if (!size)
        return 1;
    if (io->input) {
        memcpy(value, io->input, size);
        io->input += size;
    } else {
        memcpy(io->output, value, size);
        io->output += size;
    }
    io->remaining -= size;
    return 1;
}

static void* read_pointer(const void* address)
{
    void* value;
    memcpy(&value, address, sizeof(value));
    return value;
}

static void write_pointer(void* address, const void* value)
{
    memcpy(address, &value, sizeof(value));
}

static int transfer_refs(Cursor* io, const SnapshotField* field, u8* member)
{
    for (size_t i = 0; i < field->size; i += sizeof(void*)) {
        void* payload = NULL;
        u32 handle = 0;
        if (!io->input) {
            payload = read_pointer(member + i);
            if (payload && field->kind == SnapshotHeaderRef)
                payload = ObjectGetPayload((Tm4ObjectHeader*)payload);
            handle = WebSnapshotLiveHandle(payload);
        }
        if (!transfer(io, &handle, sizeof(handle)) || handle == UINT32_MAX
            || (!handle && field->kind == SnapshotRequiredRef))
            return 0;
        if (io->input && handle)
            payload = io->find(handle);
        if (handle
            && (!payload
                || (field->binding && strcmp(ObjectGetHeader(payload)->name, field->binding))))
            return 0;
        if (io->input) {
            if (payload && field->kind == SnapshotHeaderRef)
                payload = ObjectGetHeader(payload);
            write_pointer(member + i, payload);
        }
    }
    return 1;
}

static int transfer_key(Cursor* io, const SnapshotField* field, void* member)
{
    const SnapshotKeyBinding* binding = NULL;
    const SnapshotNumericBinding* numeric = NULL;
    const void* resource = NULL;
    const char* name = NULL;
    if (field->kind == SnapshotNumericKey) {
        numeric = field->binding;
        if (!io->input) {
            name = numeric->name(*(const s32*)member);
            if (!name)
                return 0;
        }
    } else {
        resource = read_pointer(member);
        if (field->kind == SnapshotKey || field->kind == SnapshotResourceString)
            binding = field->binding;
        if (!binding || field->kind == SnapshotResourceString)
            name = resource;
        else if (!io->input && resource)
            name = read_pointer((const u8*)resource + binding->name_offset);
    }
    const size_t size = !io->input && name ? strnlen(name, KeyCapacity) : 0;
    if (size == KeyCapacity || (!io->input && resource && !size))
        return 0;
    u8 length = size;
    if (!transfer(io, &length, sizeof(length)) || length >= KeyCapacity)
        return 0;
    if (!io->input)
        return transfer(io, (void*)name, length);
    char key[KeyCapacity];
    if (!transfer(io, key, length) || memchr(key, 0, length))
        return 0;
    key[length] = 0;
    if (field->kind == SnapshotTemplateKey)
        return length ? name && !strcmp(name, key) : !resource;
    if (numeric) {
        s32 id = length ? numeric->resolve(key) : -1;
        if (id < 0)
            return 0;
        *(s32*)member = id;
        return 1;
    }
    if (field->kind == SnapshotOwnedString) {
        char* allocation = length ? MemAlloc(length + 1) : NULL;
        if (length && !allocation)
            return 0;
        if (allocation)
            memcpy(allocation, key, length + 1);
        MemFree((void*)resource);
        write_pointer(member, allocation);
        return 1;
    }
    void* resolved = length ? binding->resolve(key) : NULL;
    if (length && !resolved)
        return 0;
    write_pointer(member, resolved);
    return 1;
}

static int transfer_index(
    Cursor* io, const SnapshotIndexBinding* table, const void* payload, void* member)
{
    const u32 count = table->count(payload);
    void* base = table->base(payload);
    u32 handle = 0;
    if (!io->input) {
        void* address = read_pointer(member);
        if (address) {
            const uintptr_t offset = (uintptr_t)address - (uintptr_t)base;
            if (!base || offset % table->stride || offset / table->stride >= count)
                return 0;
            handle = offset / table->stride + 1;
        }
    }
    if (!transfer(io, &handle, sizeof(handle)) || handle > count || (handle && !base))
        return 0;
    if (io->input)
        write_pointer(member, handle ? (u8*)base + (handle - 1) * table->stride : NULL);
    return 1;
}

static int transfer_fields(Cursor* io, const SnapshotField* fields, void* payload);

static int transfer_array(Cursor* io, const SnapshotField* field, void* payload, u8* member)
{
    const SnapshotArray* array = field->binding;
    const int inline_array = field->kind == SnapshotInlineArray;
    const int allocate = io->input && field->kind == SnapshotOwnedArray;
    const u32 count = array->count ? array->count(payload) : field->size / array->stride;
    u16 saved = count;
    if (count > array->limit || !transfer(io, &saved, sizeof(saved)) || saved != count
        || (inline_array && count > field->size / array->stride))
        return 0;
    u8* previous = inline_array ? member : read_pointer(member);
    u8* elements = allocate ? (count ? MemCalloc(count, array->stride) : NULL) : previous;
    if (count && !elements)
        return 0;
    for (u32 i = 0; i < count; ++i) {
        if (!transfer_fields(io, array->elements, elements + i * array->stride)) {
            if (allocate)
                MemFree(elements);
            return 0;
        }
    }
    if (allocate) {
        MemFree(previous);
        write_pointer(member, elements);
    }
    return 1;
}

static void release_list(const SnapshotList* list, void* node)
{
    while (node) {
        void* next = read_pointer((u8*)node + list->next);
        MemFree(node);
        node = next;
    }
}

static int transfer_list(Cursor* io, const SnapshotList* list, void* member)
{
    void* old = read_pointer(member);
    u8 count = 0;
    if (!io->input) {
        for (void* node = old; node; node = read_pointer((u8*)node + list->next)) {
            if (count == list->limit)
                return 0;
            ++count;
        }
    }
    if (!transfer(io, &count, sizeof(count)) || count > list->limit)
        return 0;
    if (!io->input) {
        for (void* node = old; node; node = read_pointer((u8*)node + list->next))
            if (!transfer_fields(io, list->fields, node))
                return 0;
        return 1;
    }
    void* head = NULL;
    void* tail = &head;
    for (u8 i = 0; i < count; ++i) {
        void* node = MemCalloc(1, list->node_size);
        if (!node || !transfer_fields(io, list->fields, node)) {
            MemFree(node);
            release_list(list, head);
            return 0;
        }
        write_pointer(tail, node);
        tail = (u8*)node + list->next;
    }
    release_list(list, old);
    write_pointer(member, head);
    return 1;
}

static int transfer_fields(Cursor* io, const SnapshotField* fields, void* payload)
{
    for (const SnapshotField* field = fields; field && field->kind; ++field) {
        u8* member = (u8*)payload + field->offset;
        switch (field->kind) {
        case SnapshotPod:
            if (!transfer(io, member, field->size))
                return 0;
            break;
        case SnapshotObjectRef:
        case SnapshotWeakObjectRef:
        case SnapshotRequiredRef:
        case SnapshotHeaderRef:
            if (!transfer_refs(io, field, member))
                return 0;
            break;
        case SnapshotKey:
        case SnapshotResourceString:
        case SnapshotTemplateKey:
        case SnapshotNumericKey:
        case SnapshotOwnedString:
            if (!transfer_key(io, field, member))
                return 0;
            break;
        case SnapshotGroup: {
            const SnapshotGroupFields* group = field->binding;
            if (!group->active || group->active(payload)) {
                if (!transfer_fields(io, group->fields, member))
                    return 0;
            } else if (io->input)
                memset(member, 0, field->size);
            break;
        }
        case SnapshotResourceIndex:
            if (!transfer_index(io, field->binding, payload, member))
                return 0;
            break;
        case SnapshotOwnedList:
            if (!transfer_list(io, field->binding, member))
                return 0;
            break;
        case SnapshotInlineArray:
        case SnapshotLocalArray:
        case SnapshotOwnedArray:
            if (!transfer_array(io, field, payload, member))
                return 0;
            break;
        case SnapshotTemplateField:
        case SnapshotDerivedField:
        case SnapshotTransientField:
            break;
        default:
            return 0;
        }
    }
    return 1;
}

u32 WebSnapshotFieldsCapture(const SnapshotType* type, const void* object, u8* output, u32 capacity)
{
    Cursor io = { .output = output, .remaining = capacity };
    u8 version = 1;
    if ((type->validate && !type->validate(object)) || !transfer(&io, &version, sizeof(version))
        || !transfer_fields(&io, type->fields, (void*)object))
        return 0;
    if (type->capture) {
        u32 length = type->capture(object, io.output, io.remaining);
        if (!length || length > io.remaining)
            return 0;
        io.remaining -= length;
    }
    return capacity - io.remaining;
}

int WebSnapshotFieldsRestore(const SnapshotType* type, void* object, const u8* input, u32 length,
    WebSnapshotFindObject* find)
{
    Cursor io = { .input = input, .remaining = length, .find = find };
    u8 version;
    if (!transfer(&io, &version, sizeof(version)) || version != 1
        || !transfer_fields(&io, type->fields, object))
        return 0;
    if (type->restore ? !type->restore(object, io.input, io.remaining, find) : io.remaining != 0)
        return 0;
    return !type->validate || type->validate(object);
}

static void release_fields(const SnapshotField* fields, void* object)
{
    for (const SnapshotField* field = fields; field && field->kind; ++field) {
        void* member = (u8*)object + field->offset;
        if (field->kind == SnapshotOwnedList) {
            release_list(field->binding, read_pointer(member));
            write_pointer(member, NULL);
        } else if (field->kind == SnapshotOwnedArray || field->kind == SnapshotOwnedString) {
            MemFree(read_pointer(member));
            write_pointer(member, NULL);
        } else if (field->kind == SnapshotGroup) {
            const SnapshotGroupFields* group = field->binding;
            if (!group->active || group->active(object))
                release_fields(group->fields, member);
        }
    }
}

void WebSnapshotFieldsRelease(const SnapshotType* type, void* object)
{
    release_fields(type->fields, object);
    if (type->release)
        type->release(object);
}

static int references_target(const SnapshotField* fields, const void* object, const void* target)
{
    for (const SnapshotField* field = fields; field && field->kind; ++field) {
        if (field->kind != SnapshotRequiredRef && field->kind != SnapshotObjectRef
            && field->kind != SnapshotWeakObjectRef && field->kind != SnapshotHeaderRef)
            continue;
        const void* expected = field->kind == SnapshotHeaderRef ? ObjectGetHeader(target) : target;
        for (size_t i = 0; i < field->size; i += sizeof(void*))
            if (read_pointer((const u8*)object + field->offset + i) == expected)
                return 1;
    }
    return 0;
}

static void forget_weak_references(const SnapshotField* fields, void* object, const void* target)
{
    for (const SnapshotField* field = fields; field && field->kind; ++field) {
        u8* member = (u8*)object + field->offset;
        if (field->kind == SnapshotWeakObjectRef) {
            for (size_t i = 0; i < field->size; i += sizeof(void*))
                if (read_pointer(member + i) == target)
                    write_pointer(member + i, NULL);
        } else if (field->kind == SnapshotGroup) {
            const SnapshotGroupFields* group = field->binding;
            if (!group->active || group->active(object))
                forget_weak_references(group->fields, member, target);
        } else if (field->kind == SnapshotOwnedList) {
            const SnapshotList* list = field->binding;
            void* link = member;
            void* node;
            while ((node = read_pointer(link))) {
                void* next = (u8*)node + list->next;
                if (list->discard_on_target_destroy
                    && references_target(list->fields, node, target)) {
                    write_pointer(link, read_pointer(next));
                    MemFree(node);
                } else {
                    forget_weak_references(list->fields, node, target);
                    link = next;
                }
            }
        }
    }
}

void WebSnapshotForgetWeakReferences(const SnapshotType* type, void* object, const void* target)
{
    if (type && object)
        forget_weak_references(type->fields, object, target);
}
