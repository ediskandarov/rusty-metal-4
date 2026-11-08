#include "sdk.h"

#include <psyz/gte.h>
SVECTOR* ApplyMatrixSV(MATRIX* matrix, SVECTOR* input, SVECTOR* output)
{
    SetRotMatrix(matrix);
    gte_ldv0(input);
    gte_rtv0();
    output->vx = Psyz_GteDataRead(9);
    output->vy = Psyz_GteDataRead(10);
    output->vz = Psyz_GteDataRead(11);
    return output;
}

VECTOR* Square0(VECTOR* input, VECTOR* output)
{
    Psyz_GteDataWrite(9, input->vx);
    Psyz_GteDataWrite(10, input->vy);
    Psyz_GteDataWrite(11, input->vz);
    Psyz_GteCommand(0x28);
    output->vx = Psyz_GteDataRead(25);
    output->vy = Psyz_GteDataRead(26);
    output->vz = Psyz_GteDataRead(27);
    return output;
}
void RotTransSV(SVECTOR* input, SVECTOR* output, int* flag)
{
    gte_ldv0(input);
    gte_rtv0tr();
    output->vx = Psyz_GteDataRead(9);
    output->vy = Psyz_GteDataRead(10);
    output->vz = Psyz_GteDataRead(11);
    *flag = Psyz_GteCtrlRead(31);
}
MATRIX* MulMatrix0(MATRIX* first, MATRIX* second, MATRIX* output)
{
    MATRIX result = { 0 };
    SetRotMatrix(first);
    for (int i = 0; i < 3; ++i) {
        SVECTOR column = { second->m[0][i], second->m[1][i], second->m[2][i], 0 };
        gte_ldv0(&column);
        gte_rtv0();
        result.m[0][i] = Psyz_GteDataRead(9);
        result.m[1][i] = Psyz_GteDataRead(10);
        result.m[2][i] = Psyz_GteDataRead(11);
    }
    for (int row = 0; row < 3; ++row)
        for (int column = 0; column < 3; ++column)
            output->m[row][column] = result.m[row][column];
    return output;
}

int Lzc(int value)
{
    unsigned int bits = value < 0 ? ~(unsigned int)value : (unsigned int)value;
    return bits ? __builtin_clz(bits) : 32;
}

VECTOR* ApplyRotMatrixLV(VECTOR* input, VECTOR* output)
{
    MATRIX rotation;
    ReadRotMatrix(&rotation);
    return ApplyMatrixLV(&rotation, input, output);
}
