#include "tm4/main/memory.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#if __has_feature(address_sanitizer)
#include <sanitizer/asan_interface.h>
#endif

static _Alignas(8) unsigned char heap[65536];
static uint32_t random_state = 0x19471999;
static uint32_t digest = 2166136261u;

static uint32_t next_random(void)
{
    random_state = random_state * 1664525u + 1013904223u;
    return random_state;
}

static void record(void* allocation)
{
    digest ^= allocation ? (uint32_t)((unsigned char*)allocation - heap) : UINT32_MAX;
    digest *= 16777619u;
}

int main(int argc, char** argv)
{
    unsigned char* allocations[24] = { 0 };
    unsigned sizes[24] = { 0 };
    unsigned char fills[24] = { 0 };
    MemInitHeap(heap, sizeof(heap));
    for (unsigned step = 0; step < 4000; ++step) {
        unsigned slot = next_random() % 24;
        unsigned size = 8 + next_random() % 504;
        unsigned char* old = allocations[slot];
        if (old) {
            for (unsigned i = 0; i < sizes[slot]; ++i)
                assert(old[i] == fills[slot]);
            if (next_random() & 1) {
                allocations[slot] = MemRealloc(old, size);
                assert(allocations[slot]);
                unsigned preserved = size < sizes[slot] ? size : sizes[slot];
                for (unsigned i = 0; i < preserved; ++i)
                    assert(allocations[slot][i] == fills[slot]);
            } else {
                MemFree(old);
                allocations[slot] = NULL;
            }
        } else {
            switch (next_random() % 3) {
            case 0:
                allocations[slot] = MemAlloc(size);
                break;
            case 1:
                allocations[slot] = MemAllocTail(size);
                break;
            default:
                allocations[slot] = MemCalloc(size, 1);
                for (unsigned i = 0; i < size; ++i)
                    assert(allocations[slot][i] == 0);
                break;
            }
            assert(allocations[slot]);
        }
        record(allocations[slot]);
        if (allocations[slot]) {
            sizes[slot] = size;
            fills[slot] = (unsigned char)step;
            memset(allocations[slot], fills[slot], size);
        }
    }
    for (unsigned i = 0; i < 24; ++i)
        MemFree(allocations[i]);
    unsigned char* whole = MemAlloc(sizeof(heap) - 8);
    assert(whole == heap + 8);
    memset(whole, 0x5a, sizeof(heap) - 8);
    MemFree(whole);
#if __has_feature(address_sanitizer)
    assert(__asan_address_is_poisoned(whole));
    assert(__asan_address_is_poisoned(heap + sizeof(heap) - 1));
    assert(__asan_address_is_poisoned(heap));
    if (argc > 1 && strcmp(argv[1], "use-after-free") == 0) {
        volatile unsigned char* released = whole;
        return *released;
    }
    unsigned char* first = MemAlloc(8);
    unsigned char* second = MemAlloc(8);
    assert(first == heap + 8 && second == first + 16);
    assert(!__asan_address_is_poisoned(first));
    assert(!__asan_address_is_poisoned(second));
    MemInitHeap(NULL, sizeof(heap));
    MemInitHeap(heap, 0);
    assert(MemGetBlockSize(first) == 16);
    assert(__asan_address_is_poisoned(first - 1));
    assert(__asan_address_is_poisoned(first + 8));
    if (argc > 1 && strcmp(argv[1], "overwrite-header") == 0) {
        volatile unsigned char* beyond = first + 8;
        *beyond = 0;
    }
    MemFree(first);
    MemFree(second);
#else
    (void)argc;
    (void)argv;
#endif
    printf("PASS original allocator trace %08x\n", digest);
    return 0;
}
