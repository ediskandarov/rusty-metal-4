#pragma once
#include "src/modules/carprt/private.h"

/* Debris owns its damaged group and face data, independently of its car. */
typedef struct WebCarpart {
    Carpart part;
    CarRenderGroup group;
    CarRenderFace* faces;
    char* model;
} WebCarpart;

void WebCarpartPrepareResources(void);
