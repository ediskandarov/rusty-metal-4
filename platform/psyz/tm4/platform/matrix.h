#ifndef TM4_PSYZ_MATRIX_H
#define TM4_PSYZ_MATRIX_H

#include <libgte.h>
#include "tm4/fixed.h"

/* Set the rotation only; translation and alignment padding belong to the caller. */
static inline void SetIdentityRotation(MATRIX* matrix)
{
    for (int row = 0; row < 3; ++row)
        for (int column = 0; column < 3; ++column)
            matrix->m[row][column] = row == column ? ONE : 0;
}

#endif
