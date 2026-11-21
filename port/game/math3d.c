#include "tm4_scalar.h"

#include "tm4/main/math3d.h"

#include <libgte.h>
#include "tm4/gte.h"
#include <psyz/gte.h>

u32 VectorLength12(const VECTOR* vector);
u32 VectorLengthS12(const SVECTOR* vector);
u32 VectorLengthSquared12(const VECTOR* vector);
u32 VectorLengthSquaredS0(const SVECTOR* vector);
u32 VectorLengthSquaredS12(const SVECTOR* vector);
VECTOR* Math3dSquareSL12(const SVECTOR* vector, VECTOR* output);
SVECTOR* ApplyRotMatrixMACShort12(const SVECTOR* input, SVECTOR* output);
VECTOR* ApplyRotMatrixMAC0(const SVECTOR* input, VECTOR* output);
void OuterProductSSS0(const SVECTOR* first, const SVECTOR* second, SVECTOR* output);
void OuterProductSSV12(const SVECTOR* first, const SVECTOR* second, VECTOR* output);
void OuterProductSSV0(const SVECTOR* first, const SVECTOR* second, VECTOR* output);
VECTOR* ApplyMatrixWithTranslationMAC(const MATRIX* matrix, const SVECTOR* input, VECTOR* output);

static inline void Math3dLoadAccumulator(long x, long y, long z)
{
    Psyz_GteDataWrite(25, x);
    Psyz_GteDataWrite(26, y);
    Psyz_GteDataWrite(27, z);
}

// The first vertex pad holds the edge count; other pads contain unrelated metadata.
static u32 WebPackedSinCos(s32 angle)
{
    return (u16)rsin(angle) | ((u32)(u16)rcos(angle) << 16);
}

s32 PolygonRayParameter(const Tm4CollisionPolygon* polygon, const Tm4WorldRay* ray)
{
    const s32* normal = polygon->normal;
    const SVECTOR* vertex = polygon->vertices;
    const SVECTOR* edge = polygon->edge_directions;
    long long denominator;
    long long numerator;
    unsigned long long bits;
    VECTOR from, to, cross;
    s32 count = CollisionPolygonVertexCount(polygon);

    bits = (unsigned long long)((long long)ray->displacement.vx * normal[0])
        + (unsigned long long)((long long)ray->displacement.vy * normal[1])
        + (unsigned long long)((long long)ray->displacement.vz * normal[2]);
    denominator = bits;
    if (denominator >= 0)
        return -1;
    bits = (unsigned long long)((long long)(vertex->vx - ray->origin.vx) * normal[0])
        + (unsigned long long)((long long)(vertex->vy - ray->origin.vy) * normal[1])
        + (unsigned long long)((long long)(vertex->vz - ray->origin.vz) * normal[2]);
    numerator = bits;
    if (numerator > 0 || numerator < denominator)
        return -1;
    do {
        to.vx = ray->origin.vx + ray->displacement.vx - vertex->vx;
        to.vy = ray->origin.vy + ray->displacement.vy - vertex->vy;
        to.vz = ray->origin.vz + ray->displacement.vz - vertex->vz;
        from.vx = ray->origin.vx - vertex->vx;
        from.vy = ray->origin.vy - vertex->vy;
        from.vz = ray->origin.vz - vertex->vz;
        gte_ldopv1(&to);
        gte_ldopv2(&from);
        gte_op0();
        gte_stlvnl(&cross);
        if ((long long)cross.vx * edge->vx + (long long)cross.vy * edge->vy
                + (long long)cross.vz * edge->vz
            < 0)
            return -1;
        vertex++;
        edge++;
    } while (--count > 0);
    return (long long)((unsigned long long)numerator << 12) / denominator;
}

// Sum complete signed products with unsigned low-word carry propagation.
s32 DotS12_64(const Tm4VectorComponent* first, const s16* second)
{
    // The product words follow the target's little-endian order.
    union {
        long long value;
        u32 words[2];
    } product;
    s32 component;
    u32 low, high, next;
    s32 scaled, round;

    component = second[0];
    product.value = (long long)first[0] * component;
    low = product.words[0];
    high = product.words[1];
    component = second[1];
    product.value = (long long)first[1] * component;
    next = product.words[0];
    low += next;
    high += low < next;
    high += product.words[1];
    component = second[2];
    product.value = (long long)first[2] * component;
    next = product.words[0];
    low += next;
    high += low < next;
    high += product.words[1];
    // Round Q12 halfway toward positive infinity.
    low >>= 11;
    round = low & 1;
    low >>= 1;
    scaled = low | high << 20;
    return scaled + round;
}

// Sum complete signed products with unsigned low-word carry propagation.
s32 DotV12_64(const s32* first, const s32* second)
{
    // The product words follow the target's little-endian order.
    union {
        long long value;
        u32 words[2];
    } product;
    s32 component;
    u32 low, high, next;
    s32 scaled, round;

    component = second[0];
    product.value = (long long)first[0] * component;
    low = product.words[0];
    high = product.words[1];
    component = second[1];
    product.value = (long long)first[1] * component;
    next = product.words[0];
    low += next;
    high += low < next;
    high += product.words[1];
    component = second[2];
    product.value = (long long)first[2] * component;
    next = product.words[0];
    low += next;
    high += low < next;
    high += product.words[1];
    // Round Q12 halfway toward positive infinity.
    low >>= 11;
    round = low & 1;
    low >>= 1;
    scaled = low | high << 20;
    return scaled + round;
}

// Restoring square root, with six fractional bits in the returned value.
u32 SquareRootInt32(u32 value, ...)
{
    s32 leading;
    s32 count;
    u32 root = 0, remainder = 0, trial;
    gte_Lzc(value, &leading);
    leading >>= 1;
    count = 22 - leading;
    value <<= (leading * 2) & 31;
    do {
        remainder |= value >> 30;
        value <<= 2;
        root <<= 1;
        trial = (root << 1) + 1;
        if ((s32)remainder >= (s32)trial) {
            remainder -= trial;
            root++;
        }
        remainder <<= 2;
    } while (--count != 0);
    return root;
}

// Restoring root of the high/low pair; variable shifts retain R3000 masking.
u32 SquareRoot64Shifted(u32 high, u32 low, s32 shift)
{
    s32 leading;
    s32 count;
    u32 root = 0, remainder = 0, trial;
    gte_Lzc(high, &leading);
    leading >>= 1;
    count = ((u32)shift >> 1) + 32 - leading;
    leading *= 2;
    high = (high << (leading & 31)) | (low >> ((32 - leading) & 31));
    low <<= leading & 31;
    do {
        remainder |= high >> 30;
        high = (high << 2) | (low >> 30);
        low <<= 2;
        root <<= 1;
        trial = (root << 1) + 1;
        if ((s32)remainder >= (s32)trial) {
            remainder -= trial;
            root++;
        }
        remainder <<= 2;
    } while (--count != 0);
    return root;
}

u32 VectorLengthRounded12(const VECTOR* vector)
{
    unsigned long long sum = (long long)vector->vx * vector->vx + (long long)vector->vy * vector->vy
        + (long long)vector->vz * vector->vz;
    return SquareRootInt32((sum >> 12) + ((sum >> 11) & 1));
}

u32 VectorLength64(const VECTOR* vector)
{
    unsigned long long sum = (long long)vector->vx * vector->vx + (long long)vector->vy * vector->vy
        + (long long)vector->vz * vector->vz;
    return SquareRoot64Shifted(sum >> 32, sum, 0);
}

u32 VectorLength0(const VECTOR* vector)
{
    VECTOR squared;
    u32 sum;
    gte_ldlvl(vector);
    gte_sqr0();
    gte_stlvnl(&squared);
    sum = (u32)squared.vx + squared.vy + squared.vz;
    return SquareRoot0(sum);
}

u32 VectorLength12(const VECTOR* vector)
{
    VECTOR squared;
    u32 sum;
    gte_ldlvl(vector);
    gte_sqr12();
    gte_stlvnl(&squared);
    sum = (u32)squared.vx + squared.vy + squared.vz;
    return SquareRoot12(sum);
}

u32 VectorLengthS0(const SVECTOR* vector)
{
    VECTOR squared;
    u32 sum;
    gte_ldopv2SV(vector);
    gte_sqr0();
    gte_stlvnl(&squared);
    sum = (u32)squared.vx + squared.vy + squared.vz;
    return SquareRoot0(sum);
}

u32 VectorLengthS12(const SVECTOR* vector)
{
    VECTOR squared;
    u32 sum;
    gte_ldopv2SV(vector);
    gte_sqr12();
    gte_stlvnl(&squared);
    sum = (u32)squared.vx + squared.vy + squared.vz;
    return SquareRoot12(sum);
}

u32 VectorLengthSquared0(const VECTOR* vector)
{
    VECTOR squared;
    u32 sum;
    gte_ldlvl(vector);
    gte_sqr0();
    gte_stlvnl(&squared);
    sum = (u32)squared.vx + squared.vy + squared.vz;
    return sum;
}

u32 VectorLengthSquared12(const VECTOR* vector)
{
    VECTOR squared;
    u32 sum;
    gte_ldlvl(vector);
    gte_sqr12();
    gte_stlvnl(&squared);
    sum = (u32)squared.vx + squared.vy + squared.vz;
    return sum;
}

u32 VectorLengthSquaredS0(const SVECTOR* vector)
{
    VECTOR squared;
    u32 sum;
    gte_ldopv2SV(vector);
    gte_sqr0();
    gte_stlvnl(&squared);
    sum = (u32)squared.vx + squared.vy + squared.vz;
    return sum;
}

u32 VectorLengthSquaredS12(const SVECTOR* vector)
{
    VECTOR squared;
    u32 sum;
    gte_ldopv2SV(vector);
    gte_sqr12();
    gte_stlvnl(&squared);
    sum = (u32)squared.vx + squared.vy + squared.vz;
    return sum;
}

VECTOR* SquareSL0_bugfree(const SVECTOR* vector, VECTOR* output)
{
    gte_ldopv2SV(vector);
    gte_sqr0();
    gte_stlvnl(output);
    return output;
}

VECTOR* Math3dSquareSL12(const SVECTOR* vector, VECTOR* output)
{
    gte_ldopv2SV(vector);
    gte_sqr12();
    gte_stlvnl(output);
    return output;
}

Tm4VectorXYZ* ApplyRotMatrixMAC12(const SVECTOR* input, Tm4VectorXYZ* output)
{
    register Tm4VectorXYZ* destination = output;
    gte_ldv0(input);
    gte_rtv0();
    gte_stlvnl(destination);
    return destination;
}

SVECTOR* ApplyRotMatrixMACShort12(const SVECTOR* input, SVECTOR* output)
{
    VECTOR transformed;
    gte_ldv0(input);
    gte_rtv0();
    gte_stlvnl(&transformed);
    output->vx = transformed.vx;
    output->vy = transformed.vy;
    output->vz = transformed.vz;
    return output;
}

VECTOR* ApplyRotMatrixMAC0(const SVECTOR* input, VECTOR* output)
{
    register VECTOR* destination = output;
    gte_ldv0(input);
    gte_mvmva(0, 0, 0, 3, 0);
    gte_stlvnl(destination);
    return destination;
}

SVECTOR* ApplyRotMatrixMACShort0(const SVECTOR* input, SVECTOR* output)
{
    VECTOR transformed;
    gte_ldv0(input);
    gte_mvmva(0, 0, 0, 3, 0);
    gte_stlvnl(&transformed);
    output->vx = transformed.vx;
    output->vy = transformed.vy;
    output->vz = transformed.vz;
    return output;
}

s32 DotSS0(const SVECTOR* first, const SVECTOR* second)
{
    s32 result;
    gte_ldv0(first);
    gte_ldsvrtrow0(second);
    gte_mvmva(0, 0, 0, 3, 0);
    gte_stlvnl0(&result);
    return result;
}

s32 DotSS12(const SVECTOR* first, const SVECTOR* second)
{
    s32 result;
    gte_ldv0(first);
    gte_ldsvrtrow0(second);
    gte_rtv0();
    gte_stlvnl0(&result);
    return result;
}

u32 DotSelf0(const VECTOR* vector)
{
    VECTOR squared;
    u32 sum;
    gte_ldlvl(vector);
    gte_sqr0();
    gte_stlvnl(&squared);
    sum = (u32)squared.vx + squared.vy + squared.vz;
    return sum;
}

void OuterProductSSS12(const SVECTOR* first, const SVECTOR* second, SVECTOR* output)
{
    VECTOR cross;
    gte_ldopv1SV(first);
    gte_ldopv2SV(second);
    gte_op12();
    gte_stlvnl(&cross);
    output->vx = cross.vx;
    output->vy = cross.vy;
    output->vz = cross.vz;
}

void OuterProductSSS0(const SVECTOR* first, const SVECTOR* second, SVECTOR* output)
{
    VECTOR cross;
    gte_ldopv1SV(first);
    gte_ldopv2SV(second);
    gte_op0();
    gte_stlvnl(&cross);
    output->vx = cross.vx;
    output->vy = cross.vy;
    output->vz = cross.vz;
}

void OuterProductSSV12(const SVECTOR* first, const SVECTOR* second, VECTOR* output)
{
    gte_ldopv1SV(first);
    gte_ldopv2SV(second);
    gte_op12();
    gte_stlvnl(output);
}

void OuterProductSSV0(const SVECTOR* first, const SVECTOR* second, VECTOR* output)
{
    gte_ldopv1SV(first);
    gte_ldopv2SV(second);
    gte_op0();
    gte_stlvnl(output);
}

VECTOR* SetVectorDaxpyVS0(VECTOR* output, s32 scale, const SVECTOR* axis)
{
    gte_lddp(scale);
    gte_ldopv2SV(axis);
    gte_gpf0();
    gte_stlvnl(output);
    return output;
}

VECTOR* SetVectorDaxpyVS12(VECTOR* output, s32 scale, const SVECTOR* axis)
{
    gte_lddp(scale);
    gte_ldopv2SV(axis);
    gte_gpf12();
    gte_stlvnl(output);
    return output;
}

SVECTOR* SetVectorDaxpySS12(SVECTOR* output, s32 scale, const SVECTOR* axis)
{
    VECTOR product;
    gte_lddp(scale);
    gte_ldopv2SV(axis);
    gte_gpf12();
    gte_stlvnl(&product);
    output->vx = product.vx;
    output->vy = product.vy;
    output->vz = product.vz;
    return output;
}

VECTOR* AddVectorDaxpyVSV0(VECTOR* output, s32 scale, const SVECTOR* axis, const VECTOR* base)
{
    Math3dLoadAccumulator(base->vx, base->vy, base->vz);
    gte_lddp(scale);
    gte_ldopv2SV(axis);
    gte_gpl0();
    gte_stlvnl(output);
    return output;
}

VECTOR* AddVectorDaxpyVSV12(
    Tm4Vector3 output, s32 scale, const SVECTOR* axis, const Tm4Vector3 base)
{
    Math3dLoadAccumulator(base[0], base[1], base[2]);
    gte_lddp(scale);
    gte_ldopv2SV(axis);
    gte_gpl12();
    gte_stlvnl(output);
    return (VECTOR*)output;
}

SVECTOR* AddVectorDaxpySSS12(SVECTOR* output, s32 scale, const SVECTOR* axis, const SVECTOR* base)
{
    VECTOR sum;
    gte_ldopv2SV(base);
    gte_lddp(1);
    gte_gpf0();
    gte_lddp(scale);
    gte_ldopv2SV(axis);
    gte_gpl12();
    gte_stlvnl(&sum);
    output->vx = sum.vx;
    output->vy = sum.vy;
    output->vz = sum.vz;
    return output;
}

Tm4VectorComponent* AddVectorDaxpyVSS12(
    Tm4Vector3 output, s32 scale, const SVECTOR* axis, const SVECTOR* base)
{
    gte_ldopv2SV(base);
    gte_lddp(1);
    gte_gpf0();
    gte_lddp(scale);
    gte_ldopv2SV(axis);
    gte_gpl12();
    gte_stlvnl(output);
    return output;
}

SVECTOR* ApplyRotMatrixSV(const SVECTOR* input, SVECTOR* output)
{
    gte_ldv0(input);
    gte_rtv0();
    gte_stsv(output);
    return output;
}

SVECTOR* ApplyMatrixWithTranslationSV(const MATRIX* matrix, const SVECTOR* input, SVECTOR* output)
{
    gte_SetRotMatrix(matrix);
    gte_SetTransMatrix(matrix);
    gte_ldv0(input);
    gte_rtv0tr();
    gte_stsv(output);
    return output;
}

VECTOR* ApplyMatrixWithTranslationMAC(const MATRIX* matrix, const SVECTOR* input, VECTOR* output)
{
    gte_SetRotMatrix(matrix);
    gte_SetTransMatrix(matrix);
    gte_ldv0(input);
    gte_rtv0tr();
    gte_stlvnl(output);
    return output;
}

void IdentifyMatrix(MATRIX* matrix)
{
    u32* words = (u32*)matrix;
    register u32 identity = 0x1000;

    words[0] = identity;
    words[1] = 0;
    words[2] = identity;
    words[3] = 0;
    ((u16*)matrix)[8] = identity;
}

MATRIX* RotationMatrixAngles(s32 x, s32 y, s32 z, MATRIX* matrix)
{
    s32 signX = x >> 31;
    s32 signY = y >> 31;
    s32 signZ = z >> 31;
    s32 packedX = WebPackedSinCos(((x + signX) ^ signX) & 4095);
    s32 packedY = WebPackedSinCos(((y + signY) ^ signY) & 4095);
    s32 packedZ = WebPackedSinCos(((z + signZ) ^ signZ) & 4095);
    s32 sx = ((s16)packedX + signX) ^ signX;
    s32 sy = ((s16)packedY + signY) ^ signY;
    s32 sz = ((s16)packedZ + signZ) ^ signZ;
    s32 cx = packedX >> 16, cy = packedY >> 16, cz = packedZ >> 16;
    VECTOR input, first, second, third, fourth;
    u32* words = (u32*)matrix;
    input.vx = sy;
    input.vy = sz;
    input.vz = cz;
    gte_lddp(cx);
    gte_ldlvl(&input);
    gte_gpf12();
    gte_stlvl(&first);
    gte_lddp(sx);
    gte_ldlvl(&input);
    gte_gpf12();
    gte_stlvl(&second);
    input.vx = cy;
    input.vy = second.vx;
    input.vz = first.vx;
    gte_lddp(cz);
    gte_ldlvl(&input);
    gte_gpf12();
    gte_stlvl(&third);
    input.vx = third.vy;
    gte_lddp(sz);
    gte_ldlvl(&input);
    gte_gpf12();
    gte_stlvl(&fourth);
    matrix->m[2][2] = (cy * cx) >> 12;
    words[1] = (sy & 65535) | (u32)(third.vy + first.vy) << 16;
    words[0] = (third.vx & 65535) | (u32)-fourth.vx << 16;
    words[2] = ((first.vz - fourth.vy) & 65535) | (u32) - ((cy * sx) >> 12) << 16;
    words[3] = ((second.vy - third.vz) & 65535) | (u32)(second.vz + fourth.vz) << 16;
    return matrix;
}

MATRIX* RotationMatrixX(s32 angle, MATRIX* matrix)
{
    s32 sign = angle >> 31;
    u32 packed = WebPackedSinCos(((angle + sign) ^ sign) & 4095);
    s32 sine = (s16)packed;
    u32 cosine = packed >> 16;
    u32* words = (u32*)matrix;
    sine = (sine + sign) ^ sign;
    words[0] = 4096;
    words[1] = 0;
    words[2] = cosine | (u32)-sine << 16;
    words[3] = (u32)sine << 16;
    matrix->m[2][2] = cosine;
    return matrix;
}

MATRIX* RotationMatrixY(s32 angle, MATRIX* matrix)
{
    s32 sign = angle >> 31;
    u32 packed = WebPackedSinCos(((angle + sign) ^ sign) & 4095);
    s32 sine = (s16)packed;
    u32 cosine = packed >> 16;
    u32* words = (u32*)matrix;
    sine = (sine + sign) ^ sign;
    words[0] = cosine;
    words[1] = sine & 65535;
    words[2] = 4096;
    words[3] = -sine & 65535;
    matrix->m[2][2] = cosine;
    return matrix;
}

MATRIX* RotationMatrixZ(s32 angle, MATRIX* matrix)
{
    s32 sign = angle >> 31;
    u32 packed = WebPackedSinCos(((angle + sign) ^ sign) & 4095);
    s32 sine = (s16)packed;
    u32 cosine = packed >> 16;
    u32* words = (u32*)matrix;
    sine = (sine + sign) ^ sign;
    words[0] = cosine | (u32)-sine << 16;
    words[1] = (u32)sine << 16;
    words[2] = cosine;
    words[3] = 0;
    matrix->m[2][2] = 4096;
    return matrix;
}

MATRIX* RotationMatrixYX(s32 x, s32 y, MATRIX* matrix)
{
    s32 signX = x >> 31;
    s32 signY = y >> 31;
    s32 packedX = WebPackedSinCos(((x + signX) ^ signX) & 4095);
    s32 packedY = WebPackedSinCos(((y + signY) ^ signY) & 4095);
    s32 sx = ((s16)packedX + signX) ^ signX;
    s32 sy = ((s16)packedY + signY) ^ signY;
    s32 cx = packedX >> 16;
    s32 cy = packedY >> 16;
    VECTOR input, first, second;
    u32* words = (u32*)matrix;
    // IR3 remains live across both original GPF commands.
    gte_stlvl(&input);
    input.vx = sx;
    input.vy = cx;
    gte_lddp(cy);
    gte_ldlvl(&input);
    gte_gpf12();
    gte_stlvl(&first);
    input.vz = first.vz;
    gte_lddp(sy);
    gte_ldlvl(&input);
    gte_gpf12();
    gte_stlvl(&second);
    words[2] = (cx & 65535) | (u32)-sx << 16;
    words[3] = (-sy & 65535) | (u32)first.vx << 16;
    matrix->m[2][2] = first.vy;
    words[0] = (cy & 65535) | (u32)second.vx << 16;
    words[1] = second.vy & 65535;
    return matrix;
}

void func_80025924(void)
{
}
