#ifndef TM4_WEB_SNAPSHOT_FIELDS_H
#define TM4_WEB_SNAPSHOT_FIELDS_H

#include "snapshot_object.h"

#include <stddef.h>

typedef enum {
    SnapshotFieldEnd,
    SnapshotPod,
    SnapshotObjectRef,
    SnapshotWeakObjectRef,
    SnapshotRequiredRef,
    SnapshotHeaderRef,
    SnapshotKey,
    SnapshotResourceString,
    SnapshotTemplateKey,
    SnapshotNumericKey,
    SnapshotOwnedString,
    SnapshotResourceIndex,
    SnapshotGroup,
    SnapshotOwnedList,
    SnapshotInlineArray,
    SnapshotLocalArray,
    SnapshotOwnedArray,
    SnapshotTemplateField,
    SnapshotDerivedField,
    SnapshotTransientField,
} SnapshotFieldKind;

typedef struct {
    SnapshotFieldKind kind;
    size_t offset, size;
    const void* binding;
} SnapshotField;

/* Sequence elements contain scalar state and non-owning bindings. */
typedef struct {
    const SnapshotField* fields;
    size_t node_size, next;
    u8 limit;
    u8 discard_on_target_destroy;
} SnapshotList;

typedef struct {
    const SnapshotField* fields;
    int (*active)(const void* parent);
} SnapshotGroupFields;

typedef struct {
    const SnapshotField* elements;
    size_t stride;
    u32 (*count)(const void* payload);
    u16 limit;
} SnapshotArray;

typedef struct {
    size_t name_offset;
    void* (*resolve)(char* key);
} SnapshotKeyBinding;

typedef struct {
    const char* (*name)(s32 id);
    s32 (*resolve)(char* key);
} SnapshotNumericBinding;

typedef struct {
    void* (*base)(const void* payload);
    u32 (*count)(const void* payload);
    size_t stride;
} SnapshotIndexBinding;

typedef struct {
    Tm4ObjectCallback process;
    Tm4ObjectDisplayCallback display;
    Tm4ObjectCallback destructor;
    Tm4ObjectInteractionCallback interact;
} SnapshotCustomClass;

typedef struct {
    const char* name;
    size_t size;
    const SnapshotField* fields;
    int (*validate)(const void* payload);
    u32 (*capture)(const void* payload, u8* output, u32 capacity);
    int (*restore)(void* payload, const u8* input, u32 length, WebSnapshotFindObject* find);
    u8 needs_template, baseline_removable, hash_fields;
    const SnapshotCustomClass* custom;
    Tm4ObjectCallback alternate_process;
    void (*release)(void* object);
} SnapshotType;

#define SNAP_FIELD(kind, type, field, binding)                                                     \
    { kind, offsetof(type, field), sizeof(((type*)0)->field), binding }
#define SNAP_POD(type, field) SNAP_FIELD(SnapshotPod, type, field, NULL)
#define SNAP_REF(type, field, class_name) SNAP_FIELD(SnapshotObjectRef, type, field, class_name)
#define SNAP_WEAK_REF(type, field, class_name) \
    SNAP_FIELD(SnapshotWeakObjectRef, type, field, class_name)
#define SNAP_REQUIRED(type, field, class_name)                                                     \
    SNAP_FIELD(SnapshotRequiredRef, type, field, class_name)
#define SNAP_HEADER(type, field) SNAP_FIELD(SnapshotHeaderRef, type, field, NULL)
#define SNAP_KEY(type, field, keys) SNAP_FIELD(SnapshotKey, type, field, keys)
#define SNAP_RESOURCE_STRING(type, field, keys) \
    SNAP_FIELD(SnapshotResourceString, type, field, keys)
#define SNAP_LOCAL_KEY(type, field) SNAP_FIELD(SnapshotTemplateKey, type, field, NULL)
#define SNAP_NUMERIC_KEY(type, field, keys) SNAP_FIELD(SnapshotNumericKey, type, field, keys)
#define SNAP_STRING(type, field) SNAP_FIELD(SnapshotOwnedString, type, field, NULL)
#define SNAP_GROUP(type, field, group) SNAP_FIELD(SnapshotGroup, type, field, group)
#define SNAP_INDEX(type, field, table) SNAP_FIELD(SnapshotResourceIndex, type, field, table)
#define SNAP_ARRAY(type, field, array) SNAP_FIELD(SnapshotInlineArray, type, field, array)
#define SNAP_LOCAL_ARRAY(type, field, array) SNAP_FIELD(SnapshotLocalArray, type, field, array)
#define SNAP_OWNED_ARRAY(type, field, array) SNAP_FIELD(SnapshotOwnedArray, type, field, array)
#define SNAP_LIST(type, field, list) SNAP_FIELD(SnapshotOwnedList, type, field, list)
#define SNAP_LOCAL(type, field) SNAP_FIELD(SnapshotTemplateField, type, field, NULL)
#define SNAP_DERIVED(type, field) SNAP_FIELD(SnapshotDerivedField, type, field, NULL)
#define SNAP_TRANSIENT(type, field) SNAP_FIELD(SnapshotTransientField, type, field, NULL)

u32 WebSnapshotFieldsCapture(
    const SnapshotType* type, const void* object, u8* output, u32 capacity);
int WebSnapshotFieldsRestore(const SnapshotType* type, void* object, const u8* input, u32 length,
    WebSnapshotFindObject* find);
void WebSnapshotFieldsRelease(const SnapshotType* type, void* object);
void WebSnapshotForgetWeakReferences(const SnapshotType* type, void* object, const void* target);

#endif
