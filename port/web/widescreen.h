#ifndef TM4_WEB_WIDESCREEN_H
#define TM4_WEB_WIDESCREEN_H

void WebWidescreenUpdate(void);
void WebWidescreenBeginDraw(void);
void WebWidescreenEndDraw(void);
int WebWidescreenClipX(int x, unsigned int original_width);

#endif
