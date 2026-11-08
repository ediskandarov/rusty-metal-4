/* Run as WASM: timer callbacks must match their actual word count and void return. */
#include "src/modules/timer/private.h"
#include <assert.h>
#include <stdarg.h>
#include <stdio.h>

static int destroyed, called, stored;
static Timer* expected_timer;

void ObjectDestroy(void* object)
{
    assert(object == expected_timer);
    destroyed++;
}

static int construct(Timer* timer, ...)
{
    va_list args;
    va_start(args, timer);
    int result = TimerConstructor(timer, args);
    va_end(args);
    expected_timer = timer;
    return result;
}

static void callback0(void)
{
    called++;
}
static void callback1(int value)
{
    called++;
    stored = value;
}
static void callback2(int* output, int value)
{
    called++;
    *output = value;
}
static void callback4(void* first, void* second, int flag, int index)
{
    assert(first == &stored && second == &called);
    assert(flag == -1 && index == 5);
    called++;
}
static void callback8(int a, int b, int c, int d, int e, int f, int g, int h)
{
    assert(a == -1 && b == 2 && c == 3 && d == 4);
    assert(e == 5 && f == 6 && g == 7 && h == 8);
    called++;
}

int main(void)
{
    Timer timer;
    assert(construct(&timer, 2, callback0, 0));
    TimerProcess(&timer);
    assert(!called && !destroyed && timer.remaining_ticks == 1);
    TimerProcess(&timer);
    assert(called == 1 && destroyed == 1);
    assert(construct(&timer, 0, callback1, 1, -17));
    TimerProcess(&timer);
    assert(called == 2 && destroyed == 2 && stored == -17);
    assert(construct(&timer, 1, callback2, 2, &stored, 42));
    TimerProcess(&timer);
    assert(called == 3 && destroyed == 3 && stored == 42);
    assert(construct(&timer, 1, callback4, 4, &stored, &called, -1, 5));
    TimerProcess(&timer);
    assert(called == 4 && destroyed == 4);
    assert(construct(&timer, 1, callback8, 8, -1, 2, 3, 4, 5, 6, 7, 8));
    TimerProcess(&timer);
    assert(called == 5 && destroyed == 5);
    assert(!construct(&timer, 1, callback0, 9));
    puts("PASS WASM timers: expiry, pointer/signed arguments, 0/1/2/4/8-word callbacks");
    return 0;
}
