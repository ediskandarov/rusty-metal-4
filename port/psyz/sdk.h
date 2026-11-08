#ifndef TM4_PSYZ_SDK_H
#define TM4_PSYZ_SDK_H
#include <libgte.h>
SVECTOR* ApplyMatrixSV(MATRIX* matrix, SVECTOR* input, SVECTOR* output);
VECTOR* ApplyRotMatrixLV(VECTOR* input, VECTOR* output);
int Lzc(int value);
#define SPU_KEYCH(channel) (1UL << (channel))
#define SPU_VOICECH(channel) SPU_KEYCH(channel)
#endif
