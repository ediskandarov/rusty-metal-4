#ifndef TM4_WEB_RENDER_SYNC_H
#define TM4_WEB_RENDER_SYNC_H

#define WEB_DRAW_DISTANCE_MAX_SCALE 8

extern unsigned int WebDrawDistanceScale;

void WebRenderSetLimit(unsigned int rate);
void WebRenderResetTiming(void);
int WebRenderBeginLevelFrame(void);
void WebRenderPresentLevelFrame(void);
unsigned int WebRenderWaitForFrame(void);
void WebRenderReportFrame(int phase, int late, int face_budget, int minimum, int maximum);

#endif
