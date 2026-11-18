#ifndef TM4_WEB_WIDESCREEN_H
#define TM4_WEB_WIDESCREEN_H

#include <psyz/types.h>

void WebWidescreenUpdate(void);
PsyzRect WebWidescreenDrawArea(void);
void WebWidescreenBeginDraw(void);
void WebWidescreenEndDraw(void);
int WebWidescreenClipX(int x, unsigned int original_width);

enum WebHudAnchor {
    WEB_HUD_TOP_LEFT,
    WEB_HUD_BOTTOM_LEFT,
    WEB_HUD_BOTTOM_RIGHT,
};

void WebWidescreenHudReset(int buffer);
void WebWidescreenHudBegin(int buffer, const void* ordering);
void WebWidescreenHudSection(const void* ordering, enum WebHudAnchor anchor);
void WebWidescreenHudSelect(int buffer);
void WebWidescreenHudTransform(const void* payload, float* scale, float* x, float* y);

#endif
