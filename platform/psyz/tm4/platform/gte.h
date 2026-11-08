#ifndef TM4_PSYZ_GTE_H
#define TM4_PSYZ_GTE_H

#include <libgte.h>
#include <psyz/gte.h>

#include "tm4_scalar.h"

#define GteLoadIRVector(x, y, z)                                                                   \
    do {                                                                                           \
        Psyz_GteDataWrite(9, (x));                                                                 \
        Psyz_GteDataWrite(10, (y));                                                                \
        Psyz_GteDataWrite(11, (z));                                                                \
    } while (0)

/* MAC keeps the full product; IR contains its saturated short-vector result. */
#define GteReadMACVector(x, y, z)                                                                  \
    do {                                                                                           \
        (x) = (s32)Psyz_GteDataRead(25);                                                           \
        (y) = (s32)Psyz_GteDataRead(26);                                                           \
        (z) = (s32)Psyz_GteDataRead(27);                                                           \
    } while (0)

static inline void GteLoadScreen3(const void* first, const void* second, const void* third)
{
    gte_ldsxy3(*(const u32*)first, *(const u32*)second, *(const u32*)third);
}

#define GteLoadScreen3Base(base, first, second, third) GteLoadScreen3(first, second, third)
#define GteLoadScreen(first) gte_ldsxy0(*(const u32*)(first))
#define GteStoreScreenOffset(base, offset) gte_stsxy0((u8*)(base) + (offset))
#define GteReadClipArea(area) ((area) = (s32)Psyz_GteDataRead(24))
#define GteStoreFirstDepth(depth) (*(u32*)(depth) = Psyz_GteDataRead(17))
#define GteStoreSecondDepth(depth) (*(u32*)(depth) = Psyz_GteDataRead(18))
#define GteAverageDepth3() gte_avsz3()
#define GteClip() gte_nclip()
#define GteReadDepth(depth) ((depth) = Psyz_GteDataRead(7))

#define WorldSetTransformMatrix(matrix, temporary)                                                 \
    do {                                                                                           \
        SetRotMatrix(matrix);                                                                      \
        SetTransMatrix(matrix);                                                                    \
    } while (0)

/* The SDK store touches XYZ only, preserving the destination's fourth halfword. */
#define WorldStoreShortVector(point) gte_stsv(point)
#define GteReadMAC3(z) ((z) = (s32)Psyz_GteDataRead(27))
#define GteReadMAC1MAC3(x, z)                                                                      \
    do {                                                                                           \
        (x) = (s32)Psyz_GteDataRead(25);                                                           \
        (z) = (s32)Psyz_GteDataRead(27);                                                           \
    } while (0)

/* PsyQ's scheduling variants execute the same GTE commands. */
#define gte_nop() ((void)0)
#define gte_nclip_b() gte_nclip()
#define gte_rtpt_b() gte_rtpt()
#define gte_avsz3_b() gte_avsz3()
/* PsyQ operations not yet wrapped by PsyZ's libgte.h. */
#define gte_nccs_b() gte_nccs()
#define gte_mvmva(sf, mx, v, cv, lm)                                                               \
    Psyz_GteCommand(0x12 | ((sf) << 19) | ((mx) << 17) | ((v) << 15) | ((cv) << 13) | ((lm) << 10))
#define gte_gpf12() Psyz_GteCommand(0x8003d)
#define gte_gpf0() Psyz_GteCommand(0x3d)
#define gte_op0() Psyz_GteCommand(0x0c)
#define gte_sqr0() Psyz_GteCommand(0x28)
#define gte_sqr12() Psyz_GteCommand(0x80028)
#define gte_ldlvl(v) GteLoadIRVector((v)->vx, (v)->vy, (v)->vz)
#define gte_ldopv2SV(v) GteLoadIRVector((v)->vx, (v)->vy, (v)->vz)
static inline void WebGteLoadVertex(unsigned slot, const SVECTOR* vertex)
{
    Psyz_GteDataWrite(slot * 2, (u16)vertex->vx | ((u32)(u16)vertex->vy << 16));
    Psyz_GteDataWrite(slot * 2 + 1, vertex->vz);
}
#define gte_ldv1(vertex) WebGteLoadVertex(1, vertex)
#define gte_ldv2(vertex) WebGteLoadVertex(2, vertex)

/* RTPT always consumes three slots, even at the end of a shorter vertex array.
 * Duplicate a valid vertex in unused slots; only the requested outputs are used. */
static inline void WebGteLoadVertexBatch(SVECTOR* vertices, s32 remaining)
{
    if (remaining >= 3) {
        gte_ldv3c(vertices);
    } else {
        WebGteLoadVertex(0, vertices);
        WebGteLoadVertex(1, remaining > 1 ? vertices + 1 : vertices);
        WebGteLoadVertex(2, vertices);
    }
}

static inline s32 WebGteLeadingBits(s32 value)
{
    u32 bits = value < 0 ? ~(u32)value : (u32)value;
    return bits ? __builtin_clz(bits) : 32;
}
#define gte_Lzc(value, output) (*(output) = WebGteLeadingBits(value))

#define gte_stlvnl0(out) (*(out) = (s32)Psyz_GteDataRead(25))
#define gte_ldopv1SV(v)                                                                            \
    do {                                                                                           \
        Psyz_GteCtrlWrite(0, (v)->vx);                                                             \
        Psyz_GteCtrlWrite(2, (v)->vy);                                                             \
        Psyz_GteCtrlWrite(4, (v)->vz);                                                             \
    } while (0)

#endif
