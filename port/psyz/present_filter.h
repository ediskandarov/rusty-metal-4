#ifndef TM4_PSYZ_PRESENT_FILTER_H
#define TM4_PSYZ_PRESENT_FILTER_H

/* Rectangles use glBlitFramebuffer endpoints, including vertical inversion.
 * Return nonzero when the filter has presented the image. A filter must preserve
 * GL state and leave the source framebuffer untouched. Zero uses the normal blit. */
typedef int (*PsyzPresentFilter)(
    unsigned framebuffer, const int source[4], const int destination[4]);
void Psyz_SetPresentFilter(PsyzPresentFilter filter);

#endif
