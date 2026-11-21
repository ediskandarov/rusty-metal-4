#include "port/web/widescreen.h"
#include "port/web/render_sync.h"
#include "port/web/subpixel.h"
#include "tm4/gpu.h"
#include "tm4/gte.h"
#include "tm4/main/object.h"
#include "tm4/main/render.h"
#include "tm4/main/render_scratch.h"
#include "tm4/modules/camera.h"
#include <assert.h>
#include <emscripten.h>
#include <libetc.h>
#include <stdlib.h>
#include <string.h>
#if __has_feature(address_sanitizer)
#include "src/main/object/private.h"
#endif

typedef struct Tm4SceneCellDelta {
    s8 x, z;
} Tm4SceneCellDelta;

/* Shared with arccos: 256 angle units per full turn, indexed by cosine + 256. */
const u8 ArcCosByteAngles[513] = {
#include "src/main/render_arccos.inc"
};

/* Each direction partitions 640 X/Z byte pairs into three traversal lists. */
typedef struct Tm4SceneCellOrder {
    Tm4SceneCellDelta cells[640];
    s16 counts[3];
    s16 reserved506; /* Unread by RenderScene; zero in every original bucket. */
} Tm4SceneCellOrder;

static const Tm4SceneCellOrder RenderSceneCellOrder[16] = {
#include "src/main/render_cell_order.inc"
};

/* Scale the original directional footprint, including its high/low-detail transition.
 * Keep the original lists and their exact traversal order for the 1x setting. */
typedef struct WebSceneCell {
    Tm4SceneCellDelta delta;
    u16 distance_squared;
    u8 group;
} WebSceneCell;

enum {
    SCENE_CELL_DIAMETER = 2 * WORLD_GRID_SIZE - 1,
    SCENE_CELL_CAPACITY = SCENE_CELL_DIAMETER * SCENE_CELL_DIAMETER
};

static int compare_scene_cells(const void* left, const void* right)
{
    const WebSceneCell* a = left;
    const WebSceneCell* b = right;
    if (a->group != b->group)
        return (int)a->group - b->group;
    if (a->distance_squared != b->distance_squared)
        return (int)a->distance_squared - b->distance_squared;
    if (a->delta.z != b->delta.z)
        return (int)a->delta.z - b->delta.z;
    return (int)a->delta.x - b->delta.x;
}

static int unscale_cell(int offset, int scale)
{
    return offset < 0 ? -((-offset + scale / 2) / scale) : (offset + scale / 2) / scale;
}

static void scene_cell_lists(const Tm4SceneCellOrder* original, unsigned int scale,
    const Tm4SceneCellDelta* lists[4], int counts[4])
{
    static const Tm4SceneCellOrder* cached_original;
    static unsigned int cached_scale;
    static WebSceneCell sorted[SCENE_CELL_CAPACITY];
    static Tm4SceneCellDelta expanded[SCENE_CELL_CAPACITY];
    static int expanded_counts[3];
    const Tm4SceneCellDelta* cells = original->cells;
    const s16* original_counts = original->counts;
    int group_counts[3] = { original_counts[0], original_counts[1], original_counts[2] };
    if (scale != 1) {
        if (original != cached_original || scale != cached_scale) {
            u8 groups[WORLD_GRID_SIZE][WORLD_GRID_SIZE];
            memset(groups, 0xff, sizeof(groups));
            int offset = 0;
            for (int group = 0; group < 3; ++group) {
                for (int i = 0; i < original_counts[group]; ++i) {
                    const Tm4SceneCellDelta* cell = &cells[offset++];
                    groups[cell->z + WORLD_GRID_ORIGIN][cell->x + WORLD_GRID_ORIGIN] = group;
                }
                expanded_counts[group] = 0;
            }
            int total = 0;
            for (int z = 1 - WORLD_GRID_SIZE; z < WORLD_GRID_SIZE; ++z) {
                for (int x = 1 - WORLD_GRID_SIZE; x < WORLD_GRID_SIZE; ++x) {
                    int source_x = unscale_cell(x, scale) + WORLD_GRID_ORIGIN;
                    int source_z = unscale_cell(z, scale) + WORLD_GRID_ORIGIN;
                    if ((unsigned)source_x >= WORLD_GRID_SIZE
                        || (unsigned)source_z >= WORLD_GRID_SIZE)
                        continue;
                    int group = groups[source_z][source_x];
                    if (group == 0xff)
                        continue;
                    sorted[total++] = (WebSceneCell) { { x, z }, x * x + z * z, group };
                    ++expanded_counts[group];
                }
            }
            qsort(sorted, total, sizeof(*sorted), compare_scene_cells);
            for (int i = 0; i < total; ++i)
                expanded[i] = sorted[i].delta;
            cached_original = original;
            cached_scale = scale;
        }
        cells = expanded;
        for (int group = 0; group < 3; ++group)
            group_counts[group] = expanded_counts[group];
    }
    lists[0] = cells;
    lists[1] = lists[2] = cells + group_counts[0];
    lists[3] = lists[1] + group_counts[1];
    counts[0] = group_counts[0];
    counts[1] = counts[2] = group_counts[1];
    counts[3] = group_counts[2];
}

/* Native equivalent of the recovered four-pass renderer. GPU command payloads
 * stay PS1-compatible; only the linked-list tags use PsyZ's pointer layout. */
static void project_group(
    SVECTOR* vertices, int count, RenderScratch* scratch, PsyzSubpixelPosition* precise)
{
    assert(count > 0 && (count + 2) / 3 * 3 <= RENDER_SCRATCH_PROJECTED_COUNT);
    for (int i = 0; i < count; i += 3) {
        WebGteLoadVertexBatch(&vertices[i], count - i);
        gte_rtpt();
        WebSubpixelCaptureTriple(precise + i, vertices + i, count - i < 3 ? count - i : 3);
        for (int j = 0; j < 3; ++j) {
            Tm4ProjectedVertex* projected = &scratch->projected[i + j];
            projected->screen.packed = Psyz_GteDataRead(12 + j);
            projected->vertex_depth = Psyz_GteDataRead(17 + j);
            scratch->clipped[i + j]
                = WebWidescreenClipX(projected->screen.coordinates.vx, RenderViewWidth);
        }
    }
}

static u8* emit_face(const Tm4DisplayFace* face, const Tm4ProjectedVertex* projected, u8* cursor,
    Tm4OrderingTag* tag, const PsyzSubpixelPosition* precise)
{
    const u8* indices = face->header.vertex;
    const Tm4CardQuadTexture* texture;
    int kind = face->header.color0.components.cd & TM4_FACE_TYPE_MASK;
    int size;
    /* Copy packed coordinate, color and UV words without assuming packet offsets. */
#define SCREEN(packet, n) memcpy(&(packet)->x##n, &projected[indices[n]].screen.packed, 4)
#define COLOR(packet, n) memcpy(&(packet)->r##n, &face->gouraud.color##n.packed, 4)
#define UV(packet, n) memcpy(&(packet)->u##n, &texture->pairs.uv##n, 2)
#define TEXTURE(packet)                                                                            \
    do {                                                                                           \
        (packet)->clut = texture->pairs.clut;                                                      \
        (packet)->tpage = texture->pairs.tpage;                                                    \
    } while (0)
    switch (kind) {
    case TM4_FACE_GT4: {
        POLY_GT4* packet = (POLY_GT4*)cursor;
        texture = face->gouraud.texture;
        SCREEN(packet, 0);
        SCREEN(packet, 1);
        SCREEN(packet, 2);
        SCREEN(packet, 3);
        COLOR(packet, 0);
        COLOR(packet, 1);
        COLOR(packet, 2);
        COLOR(packet, 3);
        UV(packet, 0);
        UV(packet, 1);
        UV(packet, 2);
        UV(packet, 3);
        TEXTURE(packet);
        size = sizeof(*packet);
        break;
    }
    case TM4_FACE_GT3: {
        POLY_GT3* packet = (POLY_GT3*)cursor;
        texture = face->gouraud.texture;
        SCREEN(packet, 0);
        SCREEN(packet, 1);
        SCREEN(packet, 2);
        COLOR(packet, 0);
        COLOR(packet, 1);
        COLOR(packet, 2);
        UV(packet, 0);
        UV(packet, 1);
        UV(packet, 2);
        TEXTURE(packet);
        size = sizeof(*packet);
        break;
    }
    case TM4_FACE_FT4: {
        POLY_FT4* packet = (POLY_FT4*)cursor;
        texture = face->flat.texture;
        SCREEN(packet, 0);
        SCREEN(packet, 1);
        SCREEN(packet, 2);
        SCREEN(packet, 3);
        COLOR(packet, 0);
        UV(packet, 0);
        UV(packet, 1);
        UV(packet, 2);
        UV(packet, 3);
        TEXTURE(packet);
        size = sizeof(*packet);
        break;
    }
    case TM4_FACE_FT3: {
        POLY_FT3* packet = (POLY_FT3*)cursor;
        texture = face->flat.texture;
        SCREEN(packet, 0);
        SCREEN(packet, 1);
        SCREEN(packet, 2);
        COLOR(packet, 0);
        UV(packet, 0);
        UV(packet, 1);
        UV(packet, 2);
        TEXTURE(packet);
        size = sizeof(*packet);
        break;
    }
    default:
        return cursor;
    }
#undef SCREEN
#undef COLOR
#undef UV
#undef TEXTURE
    setlen(cursor, (size - sizeof(Tm4OrderingTag)) / 4);
    int count = kind == TM4_FACE_GT4 || kind == TM4_FACE_FT4 ? 4 : 3;
    WebSubpixelPacket(cursor, precise, indices, count);
    addPrim(tag, cursor);
    return cursor + size;
}

static s32 finish_scene(s32 initial, s32 remaining)
{
    EM_ASM({ tm4Port.renderedFaces = $0; }, initial - remaining);
    return remaining;
}

s32 RenderScene(Tm4OrderingTag* ordering_table, u8* cursor, s32 ordering_size, u8* primitive_end,
    s32 remaining, Camera* view)
{
    s32 initial_remaining = remaining;
    RenderScratch* scratch = (RenderScratch*)getScratchAddr(0);
    PsyzSubpixelPosition precise[RENDER_SCRATCH_PROJECTED_COUNT];
    SVECTOR heading = { -view->camera_to_world.m[0][2], 0, view->camera_to_world.m[2][2], 0 };
    VectorNormalSS(&heading, &heading);
    int direction = (heading.vz + 8) >> 4;
    if (direction > 256)
        direction = 256;
    if (direction < -256)
        direction = -256;
    unsigned int angle = ArcCosByteAngles[direction + 256];
    if (heading.vx < 0)
        angle = 256 - angle;
    const Tm4SceneCellOrder* bucket = &RenderSceneCellOrder[((angle + 8) >> 4) & 15];
    const Tm4SceneCellDelta* lists[4];
    int counts[4];
    scene_cell_lists(bucket, WebDrawDistanceScale, lists, counts);
    EM_ASM({ tm4Port.sceneCellCounts = ([ $0, $1, $2 ]); }, counts[0], counts[1], counts[3]);
    int origin_x = (view->camera_to_world.t[0] >> WORLD_CELL_SHIFT) + WORLD_GRID_ORIGIN;
    int origin_z = (view->camera_to_world.t[2] >> WORLD_CELL_SHIFT) + WORLD_GRID_ORIGIN;
    for (int pass = 0; pass < 4; ++pass) {
        RenderGeometryPass = pass >> 1;
        for (int i = 0; i < counts[pass]; ++i) {
            int x = origin_x + lists[pass][i].x;
            int z = origin_z + lists[pass][i].z;
            if ((unsigned)x >= WORLD_GRID_SIZE || (unsigned)z >= WORLD_GRID_SIZE)
                continue;
            u16 square_index = WorldCells[z][x];
            if (square_index == 0xffff)
                continue;
            Tm4WorldSquare* square = &WorldSquares[square_index];
            if (pass != 2) {
                Tm4ObjectHeader* object = square->display_objects;
                while (object) {
#if __has_feature(address_sanitizer)
                    /* A stale grid link can point into a live, reused heap block. */
                    s32 live = ObjectValidObject(ObjectGetPayload(object));
                    if (!live)
                        EM_ASM({ tm4Port.lastDisplay = ({ object : $0, stale : true }); }, object);
                    assert(live);
                    assert(object->display);
                    if (object->class_index >= 0) {
                        assert(object->class_index < ObjectClassCount);
                        assert(object->display == ObjectClasses[object->class_index].display);
                    }
                    u8* object_output = cursor;
#endif
                    Tm4ObjectHeader* next = object->next_display;
                    SetRotMatrix(&view->world_to_camera);
                    SetTransMatrix(&view->world_to_camera);
#if __has_feature(address_sanitizer)
                    EM_ASM(
                        {
                            tm4Port.lastDisplay = ({
                                name : $0 ? UTF8ToString($0) : null,
                                object : $1,
                                callback : $2
                            });
                        },
                        object->name, object, object->display);
#endif
                    object->display(ObjectGetPayload(object), ordering_table, &cursor,
                        primitive_end, &view->world_to_camera);
#if __has_feature(address_sanitizer)
                    assert(cursor >= object_output && cursor <= primitive_end);
#endif
                    object = next;
                }
            }
            const Tm4WorldSquareGroup* group = &square->display_groups[pass >> 1];
            if (!group->face_count || remaining <= 0)
                continue;
            SVECTOR* vertices = WorldDisplayVertices + group->first_vertex;
            SetRotMatrix(&view->world_to_camera);
            SetTransMatrix(&view->world_to_camera);
            project_group(vertices, group->vertex_count, scratch, precise);
            const u8* face_bytes = group->face_list.faces;
            for (int f = 0; f < group->face_count && remaining > 0; ++f) {
                if (primitive_end - cursor < sizeof(POLY_GT4))
                    return finish_scene(initial_remaining, remaining);
                const Tm4DisplayFace* face = (const Tm4DisplayFace*)face_bytes;
                int code = face->header.color0.components.cd;
                int kind = code & TM4_FACE_TYPE_MASK;
                int gouraud = kind == TM4_FACE_GT3 || kind == TM4_FACE_GT4;
                int quad = kind == TM4_FACE_GT4 || kind == TM4_FACE_FT4;
                if (!gouraud && kind != TM4_FACE_FT3 && kind != TM4_FACE_FT4)
                    return 0;
                face_bytes
                    += gouraud ? sizeof(Tm4GouraudQuadFaceView) : sizeof(Tm4FlatQuadFaceView);
                if (pass == 2 && (code & TM4_FACE_SEMITRANSPARENT))
                    continue;
                int enabled = gouraud ? face->gouraud.color3.components.cd : face->flat.enabled;
                if (!enabled)
                    continue;
                const u8* indices = face->header.vertex;
                int clipped = 1;
                for (int j = 0; j < (quad ? 4 : 3); ++j) {
                    assert(indices[j] < group->vertex_count);
                    clipped &= scratch->clipped[indices[j]];
                }
                if (clipped)
                    continue;
                Tm4ProjectedVertex* projected = scratch->projected;
                GteLoadScreen3(&projected[indices[0]].screen, &projected[indices[1]].screen,
                    &projected[indices[2]].screen);
                gte_nclip();
                s32 area0 = (s32)Psyz_GteDataRead(24);
                s32 area1 = 1;
                if (quad) {
                    GteLoadScreen(&projected[indices[3]].screen);
                    gte_nclip();
                    area1 = (s32)Psyz_GteDataRead(24);
                }
                int two_sided = gouraud ? face->gouraud.color2.components.cd : face->flat.two_sided;
                if (area0 <= 0 && area1 > 0 && !two_sided)
                    continue;
                int depth = projected[indices[0]].vertex_depth + projected[indices[1]].vertex_depth
                    + projected[indices[2]].vertex_depth
                    + projected[indices[quad ? 3 : 0]].vertex_depth;
                depth >>= 4;
                if (depth <= 0)
                    continue;
                int bias = gouraud ? face->gouraud.color1.components.cd : face->flat.depth_bias;
                int ordering_index = depth + bias;
                if (ordering_index >= ordering_size)
                    ordering_index = ordering_size - 1;
                Tm4OrderingTag* tag = &ordering_table[ordering_index];
                size_t subdivision_size = gouraud ? 4 * (sizeof(POLY_GT4) + sizeof(POLY_GT3))
                                                  : 4 * (sizeof(POLY_FT4) + sizeof(POLY_FT3));
                if (quad && depth < 320 && primitive_end - cursor > subdivision_size) {
                    cursor = gouraud
                        ? WorldBuildGouraudSubdividedQuad(&face->gouraud, vertices, cursor, tag)
                        : WorldBuildFlatSubdividedQuad(&face->flat, vertices, cursor, tag);
                } else {
                    cursor = emit_face(face, projected, cursor, tag, precise);
                }
                --remaining;
            }
        }
    }
    return finish_scene(initial_remaining, remaining);
}
