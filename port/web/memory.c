/* Keep the original allocator; protect its metadata and free payloads in ASAN builds. */
#if __has_feature(address_sanitizer)
#include <emscripten.h>
#include <sanitizer/asan_interface.h>
#endif

#include "checkpoint_memory.h"
#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MemGetBlockSize WebMemoryGetBlockSize
#define MemInitHeap WebMemoryInitHeap
#define MemAlloc WebMemoryAlloc
#define MemAllocTail WebMemoryAllocTail
#define MemCalloc WebMemoryCalloc
#define MemRealloc WebMemoryRealloc
#define MemFree WebMemoryFree
#define MemAllocInternal WebMemoryAllocInternal

#include "src/main/memory.c"

#undef MemGetBlockSize
#undef MemInitHeap
#undef MemAlloc
#undef MemAllocTail
#undef MemCalloc
#undef MemRealloc
#undef MemFree
#undef MemAllocInternal

#if __has_feature(address_sanitizer)
static Tm4MemoryBlock* heap_begin;
static Tm4MemoryBlock* heap_end;

static void set_header_access(int accessible)
{
    for (Tm4MemoryBlock* block = heap_begin; block && block < heap_end;) {
        __asan_unpoison_memory_region(block, sizeof(*block));
        u32 units = block->unit_count;
        assert(units && units <= (u32)(heap_end - block));
        if (!accessible)
            __asan_poison_memory_region(block, sizeof(*block));
        block += units;
    }
}

static void set_free_payload_access(int accessible)
{
    Tm4MemoryBlock* block;
    for (block = MemFreeBlocks; block; block = block->next_free) {
        void* payload = block + 1;
        u32 bytes = MemUnitsToBytes(block->unit_count - 1);
        if (accessible)
            __asan_unpoison_memory_region(payload, bytes);
        else
            __asan_poison_memory_region(payload, bytes);
    }
}

static void set_allocator_access(int accessible)
{
    if (accessible)
        set_header_access(1);
    set_free_payload_access(accessible);
    if (!accessible)
        set_header_access(0);
}

u32 MemGetBlockSize(const void* allocation)
{
    if (!allocation)
        return 0;
    const Tm4MemoryBlock* header = (const Tm4MemoryBlock*)allocation - 1;
    __asan_unpoison_memory_region(header, sizeof(*header));
    u32 size = WebMemoryGetBlockSize(allocation);
    __asan_poison_memory_region(header, sizeof(*header));
    return size;
}

/* Realloc may merge and copy through free blocks. Keep those accesses legal
 * inside the allocator; poison only after the complete operation returns. */
void MemInitHeap(u8* start, u32 bytes)
{
    set_allocator_access(1);
    WebMemoryInitHeap(start, bytes);
    if (start && MemBytesToUnits(bytes)) {
        heap_begin = MemFreeBlocks;
        heap_end = heap_begin + heap_begin->unit_count;
    }
    set_allocator_access(0);
}

void* MemAllocInternal(u32 bytes, s32 from_tail)
{
    void* result;
    set_allocator_access(1);
    result = WebMemoryAllocInternal(bytes, from_tail);
    set_allocator_access(0);
    return result;
}

void* MemAlloc(u32 bytes)
{
    return MemAllocInternal(bytes, MEM_ALLOC_BEST_FIT);
}

void* MemAllocTail(u32 bytes)
{
    return MemAllocInternal(bytes, MEM_ALLOC_FROM_TAIL);
}

void* MemCalloc(s32 count, s32 bytes)
{
    void* result;
    set_allocator_access(1);
    result = WebMemoryCalloc(count, bytes);
    set_allocator_access(0);
    return result;
}

void* MemRealloc(void* allocation, u32 bytes)
{
    void* result;
    set_allocator_access(1);
    result = WebMemoryRealloc(allocation, bytes);
    set_allocator_access(0);
    return result;
}

void MemFree(void* allocation)
{
    if (allocation) {
        EM_ASM(
            {
                const records = globalThis.tm4FreedBlocks || (globalThis.tm4FreedBlocks = []);
                records.push({ start : $0, end : $0 + $1, stack : new Error('MemFree').stack });
                if (records.length > 256)
                    records.shift();
            },
            allocation, MemGetBlockSize(allocation) - sizeof(Tm4MemoryBlock));
    }
    set_allocator_access(1);
    WebMemoryFree(allocation);
    set_allocator_access(0);
}
int WebCheckpointArenaOpen(void)
{
    return 0;
}

void WebCheckpointArenaSelect(int active)
{
    assert(!active);
}

void WebCheckpointArenaClose(void) {}

int WebCheckpointResourceSpan(const void* address, u32 size)
{
    return 0;
}

u32 WebCheckpointArenaCapture(u8* output, u32 capacity)
{
    return 0;
}

int WebCheckpointArenaRestore(const u8* input, u32 length)
{
    return 0;
}

#else

enum { SimulationUnits = WEB_CHECKPOINT_ARENA_BYTES / sizeof(Tm4MemoryBlock) };

static Tm4MemoryBlock* simulation_heap;
static Tm4MemoryBlock* resource_free;
static Tm4MemoryBlock* simulation_free;
static int simulation_active;
static u32 resource_revision;
static uintptr_t resource_heap_start, resource_heap_end;

int WebCheckpointArenaOpen(void)
{
    assert(!simulation_heap && !simulation_active);
    simulation_heap = malloc(WEB_CHECKPOINT_ARENA_BYTES);
    if (!simulation_heap)
        return 0;
    assert((uintptr_t)simulation_heap % MEM_UNIT_BYTES == 0);
    Tm4MemoryBlock* saved = MemFreeBlocks;
    WebMemoryInitHeap((u8*)simulation_heap, WEB_CHECKPOINT_ARENA_BYTES);
    simulation_free = MemFreeBlocks;
    MemFreeBlocks = saved;
    return 1;
}

void WebCheckpointArenaSelect(int active)
{
    if (active == simulation_active)
        return;
    assert(!active || simulation_heap);
    assert(!MemReallocBlock);
    if (active) {
        resource_free = MemFreeBlocks;
        MemFreeBlocks = simulation_free;
    } else {
        simulation_free = MemFreeBlocks;
        MemFreeBlocks = resource_free;
    }
    simulation_active = active;
}

void WebCheckpointArenaClose(void)
{
    assert(!simulation_active);
    free(simulation_heap);
    simulation_heap = NULL;
    simulation_free = NULL;
}

static int allocation_arena(const void* allocation)
{
    uintptr_t address = (uintptr_t)allocation;
    return simulation_heap && address > (uintptr_t)simulation_heap
        && address < (uintptr_t)(simulation_heap + SimulationUnits);
}

void MemInitHeap(u8* start, u32 bytes)
{
    assert(!simulation_active);
    WebMemoryInitHeap(start, bytes);
    if (start && MemBytesToUnits(bytes)) {
        resource_heap_start = (uintptr_t)MemFreeBlocks;
        resource_heap_end = (uintptr_t)(MemFreeBlocks + MemFreeBlocks->unit_count);
    }
    ++resource_revision;
}

int WebCheckpointResourceSpan(const void* address, u32 size)
{
    const uintptr_t start = (uintptr_t)address;
    return size && start >= resource_heap_start && start < resource_heap_end
        && size <= resource_heap_end - start;
}

u32 MemGetBlockSize(const void* allocation)
{
    return WebMemoryGetBlockSize(allocation);
}

void* MemAllocInternal(u32 bytes, s32 from_tail)
{
    if (!simulation_active && bytes)
        ++resource_revision;
    void* result = WebMemoryAllocInternal(bytes, from_tail);
    if (simulation_active && result) {
        /* Free payloads are outside the checkpoint, including after address reuse. */
        Tm4MemoryBlock* header = (Tm4MemoryBlock*)result - 1;
        header->next_free = NULL;
        memset(result, 0, MemUnitsToBytes(header->unit_count - 1));
    }
    return result;
}

void* MemAlloc(u32 bytes)
{
    return MemAllocInternal(bytes, MEM_ALLOC_BEST_FIT);
}

void* MemAllocTail(u32 bytes)
{
    return MemAllocInternal(bytes, MEM_ALLOC_FROM_TAIL);
}

void* MemCalloc(s32 count, s32 bytes)
{
    if (simulation_active)
        return MemAlloc(count * bytes);
    if (count && bytes)
        ++resource_revision;
    return WebMemoryCalloc(count, bytes);
}

void* MemRealloc(void* allocation, u32 bytes)
{
    int saved = simulation_active;
    if (allocation)
        WebCheckpointArenaSelect(allocation_arena(allocation));
    if (!simulation_active && (allocation || bytes))
        ++resource_revision;
    const u32 previous_size = simulation_active && allocation
        ? WebMemoryGetBlockSize(allocation) - sizeof(Tm4MemoryBlock) : 0;
    void* result = WebMemoryRealloc(allocation, bytes);
    if (simulation_active && result) {
        Tm4MemoryBlock* header = (Tm4MemoryBlock*)result - 1;
        header->next_free = NULL;
        u32 size = MemUnitsToBytes(header->unit_count - 1);
        if (size > previous_size)
            memset((u8*)result + previous_size, 0, size - previous_size);
    }
    WebCheckpointArenaSelect(saved);
    return result;
}

void MemFree(void* allocation)
{
    if (!allocation)
        return;
    int saved = simulation_active;
    WebCheckpointArenaSelect(allocation_arena(allocation));
    if (!simulation_active)
        ++resource_revision;
    WebMemoryFree(allocation);
    WebCheckpointArenaSelect(saved);
}

typedef struct {
    u32 free_offset;
    u32 resource_revision;
} ArenaHeader;

enum { NoFreeBlock = UINT32_MAX };

u32 WebCheckpointArenaCapture(u8* output, u32 capacity)
{
    if (!simulation_heap || simulation_active || MemReallocBlock
        || (output && capacity < sizeof(ArenaHeader)))
        return 0;

    const ArenaHeader header = {
        simulation_free ? simulation_free - simulation_heap : NoFreeBlock,
        resource_revision,
    };
    if (output)
        memcpy(output, &header, sizeof(header));
    u32 length = sizeof(header);
    Tm4MemoryBlock* free_block = simulation_free;
    Tm4MemoryBlock* end = simulation_heap + SimulationUnits;
    for (Tm4MemoryBlock* block = simulation_heap; block < end; block += block->unit_count) {
        if (!block->unit_count || block->unit_count > (u32)(end - block))
            return 0;
        u32 size = block == free_block ? sizeof(*block) : MemUnitsToBytes(block->unit_count);
        if (output) {
            if (size > capacity - length)
                return 0;
            memcpy(output + length, block, size);
        }
        length += size;
        if (block == free_block)
            free_block = block->next_free;
    }
    return free_block ? 0 : length;
}

int WebCheckpointArenaRestore(const u8* input, u32 length)
{
    if (!simulation_heap || simulation_active || MemReallocBlock || length < sizeof(ArenaHeader))
        return 0;
    ArenaHeader header;
    memcpy(&header, input, sizeof(header));
    if (header.resource_revision != resource_revision)
        return 0;

    /* Only the opaque same-instance capture can call this. Free payloads are not retained. */
    const u32 units = SimulationUnits;
    u32 free_offset = header.free_offset;
    u32 position = sizeof(header);
    for (u32 offset = 0; offset < units;) {
        Tm4MemoryBlock saved;
        memcpy(&saved, input + position, sizeof(saved));
        const int free = offset == free_offset;
        u32 size = free ? sizeof(saved) : MemUnitsToBytes(saved.unit_count);
        memcpy(simulation_heap + offset, input + position, size);
        if (free)
            free_offset = saved.next_free ? saved.next_free - simulation_heap : NoFreeBlock;
        position += size;
        offset += saved.unit_count;
    }
    assert(position == length);
    simulation_free
        = header.free_offset == NoFreeBlock ? NULL : simulation_heap + header.free_offset;
    return 1;
}

#endif
