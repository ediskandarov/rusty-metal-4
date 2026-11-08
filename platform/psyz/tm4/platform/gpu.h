#ifndef TM4_PSYZ_GPU_H
#define TM4_PSYZ_GPU_H

#include <libgpu.h>

typedef OT_TYPE Tm4OrderingTag;

#define GpuLinkPacketFullWord(entry, packet, size)                                                 \
    do {                                                                                           \
        setlen(packet, GpuPacketPayloadWords(size));                                               \
        addPrim(entry, packet);                                                                    \
    } while (0)

#endif
