#include "checkpoint.h"
#include "checkpoint_memory.h"
#include "interpolation.h"
#include "net_state.h"
#include "src/main/object/private.h"
#include "src/modules/car/private.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"
#include "tm4/main/pad.h"
#include "tm4/main/registry.h"
#include "tm4/main/system.h"
#include <stdlib.h>
#include <string.h>

u32 WebCheckpointGteCapture(void* output, u32 capacity);
void WebCheckpointGteRestore(const void* input);
void WebCheckpointSetRandomState(u32 random, u32 effects);

typedef struct {
    Tm4ObjectHeader* display;
    Tm4ObjectHeader* interaction;
    Tm4WorldSquare* next;
} CellLinks;

typedef struct {
    Tm4GameInfo game;
    Tm4GameOptions options;
    PadCache pads[8];
    u8 gte[256];
    RegistryDirectory* directory;
    Tm4ObjectHeader* lists[OBJECT_LIST_COUNT];
    Tm4WorldSquare* active_cells;
    Tm4WorldSquare* squares;
    CarDetonationNode* detonation;
    CarAiWorld ai;
    CarAiHealthEntry health_pickups[32];
    s32 health_pickup_count;
    s32 frame;
    u32 serial;
    u32 random;
    u32 effect_random;
    u16 path_generation, random_generation, health_generation;
    s32 square_count;
    CellLinks cells[];
} SimulationRoots;

typedef struct {
    void* address;
    u32 size;
    u8 previous[sizeof(Tm4CollisionPolygon)];
} WorldChange;

enum {
    MaxWorldSquares = 4096,
    MaxWorldChanges = 2048,
    MaxSnapshots = WebCheckpointHistoryTicks + 1,
    MaxSnapshotBytes = 8 * 1024 * 1024,
};

typedef struct {
    u8* arena;
    SimulationRoots* roots;
    u32 arena_length;
    u32 bytes;
    u32 tick;
    u32 world_mark;
} Snapshot;

static struct {
    Snapshot snapshots[MaxSnapshots];
    u32 count;
    u32 bytes;
    u32 world_changes;
    const char* blocker;
    WorldChange* changes;
} checkpoint;

static s32 square_count(void)
{
    const s32* count = RegGetFileDataS("/world/squares/numSquares");
    return count ? *count : 0;
}

static int object_boundary(void)
{
    return !ObjectNextProcess && !ObjectCurrentProcess && !ObjectNextInteractionCell
        && !ObjectInteractionFirst && !ObjectInteractionCurrent && !ObjectInteractionNextCurrent
        && !ObjectInteractionSecond && !ObjectInteractionNextCandidate && !ObjectNextDestroy
        && !ObjectDestroyResumeStack && !ObjectDestroyResumeCount && !ObjectCreateStackRouteState;
}

static void release_snapshot(const Snapshot* snapshot)
{
    free(snapshot->arena);
    free(snapshot->roots);
    checkpoint.bytes -= snapshot->bytes;
}

static void evict_oldest(void)
{
    release_snapshot(&checkpoint.snapshots[0]);
    --checkpoint.count;
    memmove(checkpoint.snapshots, checkpoint.snapshots + 1,
        checkpoint.count * sizeof(checkpoint.snapshots[0]));
    const u32 expired = checkpoint.snapshots[0].world_mark;
    if (expired) {
        /* No surviving checkpoint needs to undo the prefix before the new oldest one. */
        checkpoint.world_changes -= expired;
        memmove(checkpoint.changes, checkpoint.changes + expired,
            checkpoint.world_changes * sizeof(*checkpoint.changes));
        for (u32 i = 0; i < checkpoint.count; ++i)
            checkpoint.snapshots[i].world_mark -= expired;
    }
}

void WebCheckpointDiscard(void)
{
    while (checkpoint.count)
        release_snapshot(&checkpoint.snapshots[--checkpoint.count]);
    free(checkpoint.changes);
    checkpoint.changes = NULL;
    checkpoint.world_changes = 0;
    checkpoint.blocker = NULL;
}

u32 WebCheckpointStorageBytes(void)
{
    return checkpoint.bytes
        + (checkpoint.changes ? MaxWorldChanges * sizeof(*checkpoint.changes) : 0);
}

u32 WebCheckpointCapture(u32 tick, int retain_history)
{
    if (retain_history && checkpoint.count
        && (checkpoint.blocker || tick != checkpoint.snapshots[checkpoint.count - 1].tick + 1))
        return 0;
    const s32 count = square_count();
    if (!object_boundary() || !WorldSquares || count <= 0 || count > MaxWorldSquares
        || WebNetCaptureDigest(1).unsupported)
        return 0;

    const u32 roots_length = sizeof(SimulationRoots) + count * sizeof(CellLinks);
    const u32 arena_length = WebCheckpointArenaCapture(NULL, 0);
    const u32 snapshot_bytes = roots_length + arena_length;
    const u32 retained_bytes = retain_history
        ? checkpoint.bytes - (checkpoint.count == MaxSnapshots ? checkpoint.snapshots[0].bytes : 0)
        : 0;
    if (!arena_length || snapshot_bytes > MaxSnapshotBytes - retained_bytes)
        return 0;
    u8* arena = malloc(arena_length);
    SimulationRoots* roots = malloc(roots_length);
    if (!roots || !arena || WebCheckpointArenaCapture(arena, arena_length) != arena_length) {
        free(arena);
        free(roots);
        return 0;
    }
    *roots = (SimulationRoots) {
        .game = GameInfo,
        .options = GameOptions,
        .directory = RegGetCurrentDirectoryPtr(),
        .active_cells = ObjectActiveInteractionCells,
        .squares = WorldSquares,
        .detonation = CarDetonationDevices,
        .ai = aiWorldInfo,
        .health_pickup_count = CarHealthPickupCount,
        .frame = MainFrameCount,
        .serial = ObjectNextSerial,
        .random = randseed(),
        .effect_random = WebRenderEffectRandomState(),
        .path_generation = CarPathSearchGeneration,
        .random_generation = CarRandomSearchGeneration[0],
        .health_generation = CarHealthSearchGeneration,
        .square_count = count,
    };
    if (!WebCheckpointGteCapture(roots->gte, sizeof(roots->gte))) {
        free(arena);
        free(roots);
        return 0;
    }
    memcpy(roots->pads, PadJpad, sizeof(PadJpad));
    memcpy(roots->health_pickups, CarHealthPickups, sizeof(CarHealthPickups));
    for (unsigned i = 0; i < OBJECT_LIST_COUNT; ++i)
        roots->lists[i] = ObjectLists[i].first;
    for (s32 i = 0; i < count; ++i) {
        const Tm4WorldSquare* square = &WorldSquares[i];
        roots->cells[i] = (CellLinks) {
            square->display_objects,
            square->interaction_objects,
            square->active_next,
        };
    }
    if (!retain_history)
        WebCheckpointDiscard();
    else if (checkpoint.count == MaxSnapshots)
        evict_oldest();
    checkpoint.snapshots[checkpoint.count++] = (Snapshot) {
        .arena = arena,
        .roots = roots,
        .arena_length = arena_length,
        .bytes = snapshot_bytes,
        .tick = tick,
        .world_mark = checkpoint.world_changes,
    };
    checkpoint.bytes += snapshot_bytes;
    return snapshot_bytes;
}

void WebCheckpointWorldWrite(void* address, u32 size)
{
    if (!checkpoint.count || checkpoint.blocker)
        return;
    if (!WebCheckpointResourceSpan(address, size)) {
        checkpoint.blocker = "world mutation outside the resource arena";
        return;
    }
    if (checkpoint.world_changes == MaxWorldChanges
        || size > sizeof(checkpoint.changes[0].previous)) {
        checkpoint.blocker = "world mutation capacity exceeded";
        return;
    }
    if (!checkpoint.changes) {
        checkpoint.changes = malloc(MaxWorldChanges * sizeof(*checkpoint.changes));
        if (!checkpoint.changes) {
            checkpoint.blocker = "world mutation storage unavailable";
            return;
        }
    }
    WorldChange* entry = &checkpoint.changes[checkpoint.world_changes++];
    entry->address = address;
    entry->size = size;
    memcpy(entry->previous, address, size);
}

void WebCheckpointRejectState(void)
{
    if (checkpoint.count && !checkpoint.blocker)
        checkpoint.blocker = "timeline entered unsupported simulation state";
}

const char* WebCheckpointRestore(u32 tick)
{
    u32 index = 0;
    while (index < checkpoint.count && checkpoint.snapshots[index].tick != tick)
        ++index;
    if (index == checkpoint.count)
        return "checkpoint tick is outside retained history";
    if (checkpoint.blocker)
        return checkpoint.blocker;
    const Snapshot* snapshot = &checkpoint.snapshots[index];
    const SimulationRoots* roots = snapshot->roots;
    u8 gte[sizeof(roots->gte)];
    if (!object_boundary() || !WebCheckpointGteCapture(gte, sizeof(gte)))
        return "simulation callbacks have not completed";
    if (WorldSquares != roots->squares || square_count() != roots->square_count
        || !WebCheckpointArenaRestore(snapshot->arena, snapshot->arena_length))
        return "match resources changed since capture";

    while (checkpoint.count > index + 1)
        release_snapshot(&checkpoint.snapshots[--checkpoint.count]);
    while (checkpoint.world_changes > snapshot->world_mark) {
        const WorldChange* entry = &checkpoint.changes[--checkpoint.world_changes];
        memcpy(entry->address, entry->previous, entry->size);
    }
    WebCheckpointGteRestore(roots->gte);
    GameInfo = roots->game;
    GameOptions = roots->options;
    memcpy(PadJpad, roots->pads, sizeof(PadJpad));
    RegChangeCurrentDirectoryP(roots->directory);
    for (unsigned i = 0; i < OBJECT_LIST_COUNT; ++i)
        ObjectLists[i].first = roots->lists[i];
    for (s32 i = 0; i < roots->square_count; ++i) {
        Tm4WorldSquare* square = &WorldSquares[i];
        const CellLinks* cell = &roots->cells[i];
        square->display_objects = cell->display;
        square->interaction_objects = cell->interaction;
        square->active_next = cell->next;
    }
    ObjectActiveInteractionCells = roots->active_cells;
    ObjectNextSerial = roots->serial;
    CarDetonationDevices = roots->detonation;
    aiWorldInfo = roots->ai;
    memcpy(CarHealthPickups, roots->health_pickups, sizeof(CarHealthPickups));
    CarHealthPickupCount = roots->health_pickup_count;
    CarPathSearchGeneration = roots->path_generation;
    CarRandomSearchGeneration[0] = roots->random_generation;
    CarHealthSearchGeneration = roots->health_generation;
    MainFrameCount = roots->frame;
    WebCheckpointSetRandomState(roots->random, roots->effect_random);
    return NULL;
}
