#ifndef TM4_WEB_CAR_H
#define TM4_WEB_CAR_H
#include "tm4/modules/camera.h"
#include <libgpu.h>
#include <libgte.h>
extern unsigned int WebCarLodDistanceScale;
void WebCarResetSearchState(void);
void WebCarEnable(void);
void WebCarStart(void);
void WebCarStep(void);
#endif
