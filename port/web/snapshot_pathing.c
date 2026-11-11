#include "snapshot_pathing.h"

#include "src/main/object/private.h"

#include <string.h>

enum { PathDepth = 8, PathSamples = 512 };

typedef struct {
    u16 depth;
    u16 indices[PathDepth];
} PathResource;

static const SnapshotField path_sample_fields[] = {
    SNAP_POD(SVECTOR, vx),
    SNAP_POD(SVECTOR, vy),
    SNAP_POD(SVECTOR, vz),
    SNAP_TRANSIENT(SVECTOR, pad),
    { 0 },
};

static u32 sample_count(const void* payload)
{
    return ((const PathingInfo*)payload)->sample_count;
}

static const SnapshotArray samples = {
    path_sample_fields, sizeof(SVECTOR), sample_count, PathSamples,
};

static const SnapshotField path_fields[] = {
    SNAP_POD(PathingInfo, resource_type),
    SNAP_DERIVED(PathingInfo, points),
    SNAP_POD(PathingInfo, point_count),
    SNAP_POD(PathingInfo, segment_start_index),
    SNAP_POD(PathingInfo, segment_end_index),
    SNAP_POD(PathingInfo, sample_count),
    SNAP_OWNED_ARRAY(PathingInfo, world_samples, &samples),
    SNAP_POD(PathingInfo, sampling_speed_per_frame),
    SNAP_POD(PathingInfo, sample_index),
    SNAP_POD(PathingInfo, segment_length),
    SNAP_POD(PathingInfo, distance_to_sample),
    SNAP_POD(PathingInfo, sample_length_squared),
    SNAP_POD(PathingInfo, sample_progress_squared),
    SNAP_POD(PathingInfo, segment_fraction_q12),
    SNAP_POD(PathingInfo, speed_per_frame),
    SNAP_POD(PathingInfo, speed_per_frame_squared),
    SNAP_POD(PathingInfo, local_to_world.m),
    SNAP_POD(PathingInfo, local_to_world.t),
    SNAP_POD(PathingInfo, previous_local_to_world.m),
    SNAP_POD(PathingInfo, previous_local_to_world.t),
    SNAP_POD(PathingInfo, wrapped),
    { 0 },
};

const SnapshotGroupFields WebSnapshotPathFields = { path_fields, NULL };

static RegistryDirectory* class_directory(const void* object)
{
    const s32 index = ObjectGetHeader(object)->class_index;
    return index >= 0 && index < ObjectClassCount ? ObjectClasses[index].directory : NULL;
}

static int path_type_valid(s32 type)
{
    return type == PATHING_LOCATION_3D_ARRAY || type == PATHING_LOCATION_DIR_3D_ARRAY
        || type == PATHING_LOCATION_ORIENT_3D_ARRAY || type == PATHING_LOCATION_ORIENT_SPEED_3D_ARRAY
        || type == PATHING_LOCATION_SPEED_3D_ARRAY || type == PATHING_LOCATION_DIR_SPEED_3D_ARRAY;
}

int WebSnapshotPathValid(const PathingInfo* path)
{
    return path->points.data && path_type_valid(path->resource_type)
        && path->point_count >= 2 && path->segment_start_index >= 0
        && path->segment_start_index < path->point_count && path->segment_end_index >= 0
        && path->segment_end_index < path->point_count && path->sample_count >= 2
        && path->sample_count <= PathSamples && path->world_samples && path->sample_index >= 0
        && path->sample_index < path->sample_count - 1 && path->speed_per_frame >= 0
        && path->speed_per_frame <= INT16_MAX
        && path->speed_per_frame_squared == path->speed_per_frame * path->speed_per_frame
        && path->sample_progress_squared >= 0
        && path->sample_progress_squared < path->sample_length_squared
        && (u32)path->wrapped <= 1;
}

static RegistryFile* path_file(RegistryDirectory* directory, const PathingInfo* path)
{
    RegistryFile* file = RegGetFilePtrPS(directory, PathingPathKey);
    return file && RegGetFileArraySizeP(file) == path->point_count
            && RegGetFileTypeP(file) == path->resource_type ? file : NULL;
}

static int find_resource(
    RegistryDirectory* directory, const PathingInfo* path, PathResource* binding, u16 depth)
{
    RegistryFile* file = path_file(directory, path);
    if (file && RegGetFileDataP(file) == path->points.data) {
        binding->depth = depth;
        return 1;
    }
    if (depth == PathDepth)
        return 0;
    const s32 count = RegGetNumberOfDirectoriesP(directory);
    if (count < 0 || count > UINT16_MAX)
        return 0;
    for (s32 i = 0; i < count; ++i) {
        RegistryDirectory* child = RegGetDirectoryPtrPN(directory, i);
        if (child && find_resource(child, path, binding, depth + 1)) {
            binding->indices[depth] = i;
            return 1;
        }
    }
    return 0;
}

u32 WebSnapshotPathCapture(const PathingInfo* path, const void* object, u8* output, u32 capacity)
{
    RegistryDirectory* directory = class_directory(object);
    PathResource binding = { 0 };
    if (capacity < sizeof(binding) || !directory || !find_resource(directory, path, &binding, 0))
        return 0;
    memcpy(output, &binding, sizeof(binding));
    return sizeof(binding);
}

RegistryDirectory* WebSnapshotPathRestore(
    PathingInfo* path, const void* object, const u8* input, u32 length)
{
    PathResource binding;
    if (length != sizeof(binding))
        return NULL;
    memcpy(&binding, input, sizeof(binding));
    if (binding.depth > PathDepth || !path_type_valid(path->resource_type))
        return NULL;
    RegistryDirectory* directory = class_directory(object);
    for (u16 i = 0; directory && i < binding.depth; ++i)
        directory = binding.indices[i] < RegGetNumberOfDirectoriesP(directory)
            ? RegGetDirectoryPtrPN(directory, binding.indices[i]) : NULL;
    RegistryFile* file = directory ? path_file(directory, path) : NULL;
    if (!file)
        return NULL;
    path->points.data = RegGetFileDataP(file);
    return WebSnapshotPathValid(path) ? directory : NULL;
}


int WebSnapshotPathBoxRestore(Box* box, Tm4WorldInfoBundle* world)
{
    if (box->polyhedron)
        return 1;
    SVECTOR minimum, maximum;
    if (!world || WorldObjectGetBoundingBox(world, &minimum, &maximum) != 1)
        return 0;
    BoxConstructor(box, &minimum, &maximum);
    return box->polyhedron != NULL;
}

void WebSnapshotPathBoxRelease(Box* box)
{
    if (box->polyhedron)
        BoxDestructor(box);
}
