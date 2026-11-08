#ifndef TM4_WEB_CAR_H
#define TM4_WEB_CAR_H
#include <libgte.h>
#include "tm4/modules/camera.h"
#include <libgpu.h>
extern unsigned int WebCarLodDistanceScale;
void WebCarResetSearchState(void);
void WebCarEnable(void);
void WebCarStart(void);
void WebCarStep(void);
#endif
