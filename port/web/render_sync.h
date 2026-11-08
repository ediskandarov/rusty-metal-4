#ifndef TM4_WEB_RENDER_SYNC_H
#define TM4_WEB_RENDER_SYNC_H

#define WEB_DRAW_DISTANCE_MAX_SCALE 8

extern unsigned int WebDrawDistanceScale;

void WebRenderResetTiming(void);
void WebRenderPresentLevelFrame(int interpolate);
unsigned int WebRenderWaitForFrame(void);
void WebRenderReportFrame(int phase, int late, int face_budget, int minimum, int maximum);

#endif
