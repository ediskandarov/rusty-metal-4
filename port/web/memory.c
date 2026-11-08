/* Keep the original allocator; protect its metadata and free payloads in ASAN builds. */
#if __has_feature(address_sanitizer)
#include <assert.h>
#include <emscripten.h>
#include <sanitizer/asan_interface.h>

#define MemGetBlockSize WebMemoryGetBlockSize
#define MemInitHeap WebMemoryInitHeap
#define MemAlloc WebMemoryAlloc
#define MemAllocTail WebMemoryAllocTail
#define MemCalloc WebMemoryCalloc
#define MemRealloc WebMemoryRealloc
#define MemFree WebMemoryFree
#define MemAllocInternal WebMemoryAllocInternal
#endif

#include "src/main/memory.c"

#if __has_feature(address_sanitizer)
#undef MemGetBlockSize
#undef MemInitHeap
#undef MemAlloc
#undef MemAllocTail
#undef MemCalloc
#undef MemRealloc
#undef MemFree
#undef MemAllocInternal

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
#endif
