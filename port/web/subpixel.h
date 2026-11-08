#ifndef TM4_WEB_SUBPIXEL_H
#define TM4_WEB_SUBPIXEL_H

#include <libgte.h>
#include "../psyz/subpixel.h"
#include <libgpu.h>

enum WebSubpixelBuffer {
    WEB_SUBPIXEL_NONE = -1,
    WEB_SUBPIXEL_MENU,
    WEB_SUBPIXEL_GAME_0,
    WEB_SUBPIXEL_GAME_1,
    WEB_SUBPIXEL_BUFFER_COUNT,
};

void WebSubpixelBegin(enum WebSubpixelBuffer buffer);
void WebSubpixelSelect(enum WebSubpixelBuffer buffer);
void WebSubpixelDraw(enum WebSubpixelBuffer buffer, OT_TYPE* ordering);
void WebSubpixelCaptureTriple(PsyzSubpixelPosition* positions, const SVECTOR* vertices, int count);
void WebSubpixelCapturePoints(PsyzSubpixelPosition* positions, const SVECTOR* const* vertices,
    const u_long* const* packed_positions, int count);
void WebSubpixelPacketQuad(const void* packet, const SVECTOR* const corners[4]);
void WebSubpixelPacket(const void* packet, const PsyzSubpixelPosition* positions,
    const unsigned char* indices, int count);
const PsyzSubpixelPosition* WebSubpixelFindPacket(
    const u_long* payload, int count, unsigned int* options);
void WebSubpixelRecordSubmission(
    const u_long* packets, const PsyzSubpixelPosition* positions, int count);

#endif
