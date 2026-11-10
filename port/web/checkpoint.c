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

enum { MaxWorldSquares = 4096, MaxWorldChanges = 2048 };

static struct {
    u8* arena;
    SimulationRoots* roots;
    u32 arena_length;
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

void WebCheckpointDiscard(void)
{
    free(checkpoint.arena);
    free(checkpoint.roots);
    free(checkpoint.changes);
    checkpoint.arena = NULL;
    checkpoint.roots = NULL;
    checkpoint.changes = NULL;
    checkpoint.arena_length = 0;
    checkpoint.world_changes = 0;
    checkpoint.blocker = NULL;
}

u32 WebCheckpointCapture(void)
{
    const s32 count = square_count();
    if (!object_boundary() || !WorldSquares || count <= 0 || count > MaxWorldSquares
        || WebNetCaptureDigest(1).unsupported)
        return 0;

    const u32 roots_length = sizeof(SimulationRoots) + count * sizeof(CellLinks);
    const u32 arena_length = WebCheckpointArenaCapture(NULL, 0);
    u8* arena = arena_length ? malloc(arena_length) : NULL;
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
    WebCheckpointDiscard();
    checkpoint.arena = arena;
    checkpoint.roots = roots;
    checkpoint.arena_length = arena_length;
    return roots_length + arena_length;
}

void WebCheckpointWorldWrite(void* address, u32 size)
{
    if (!checkpoint.roots || checkpoint.blocker)
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
    if (checkpoint.roots && !checkpoint.blocker)
        checkpoint.blocker = "timeline entered unsupported simulation state";
}

const char* WebCheckpointRestore(void)
{
    const SimulationRoots* roots = checkpoint.roots;
    u8 gte[sizeof(roots->gte)];
    if (!roots)
        return "no checkpoint in this match";
    if (checkpoint.blocker)
        return checkpoint.blocker;
    if (!object_boundary() || !WebCheckpointGteCapture(gte, sizeof(gte)))
        return "simulation callbacks have not completed";
    if (WorldSquares != roots->squares || square_count() != roots->square_count
        || !WebCheckpointArenaRestore(checkpoint.arena, checkpoint.arena_length))
        return "match resources changed since capture";

    while (checkpoint.world_changes) {
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
