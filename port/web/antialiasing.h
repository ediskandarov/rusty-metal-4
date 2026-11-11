#ifndef TM4_WEB_ANTIALIASING_H
#define TM4_WEB_ANTIALIASING_H

int WebAntialiasingPresent(unsigned framebuffer, const int source[4], const int destination[4]);
void WebAntialiasingShutdown(void);

#endif
