#include <libgte.h>
#include <stdint.h>

long __real_SquareRoot0(long squared);

/* Overflowed AI distances reach SquareRoot0 with the sign bit set. The original
 * SDK indexes before SQRT (0x80054f4c), into rcossin_tbl (0x80050edc). PsyZ wraps
 * that invalid index within SQRT instead. Reproduce TM4's actual lookup without
 * reading outside a C array; this is game-layout compatibility, not an SDK fix. */
long __wrap_SquareRoot0(long squared)
{
    if (squared >= 0)
        return __real_SquareRoot0(squared);
    if (squared == -1)
        return 0;

    unsigned shift = __builtin_clz(~(uint32_t)squared) & ~1u;
    int32_t normalized = shift >= 24 ? (int32_t)((uint32_t)squared << (shift - 24))
                                     : (int32_t)squared >> (24 - shift);
    const int sqrt_halfword_offset = (0x80054f4c - 0x80050edc) / sizeof(int16_t);
    int halfword = sqrt_halfword_offset + normalized - 64;
    int sample = halfword & 1 ? rcos(halfword / 2) : rsin(halfword / 2);
    return ((uint32_t)sample << ((31 - shift) / 2)) >> 12;
}
