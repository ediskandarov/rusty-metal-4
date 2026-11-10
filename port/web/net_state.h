#ifndef TM4_WEB_NET_STATE_H
#define TM4_WEB_NET_STATE_H

#include "tm4_scalar.h"

typedef struct WebNetStateDigest {
    u32 session;
    u32 cars;
    u32 objects;
    u32 world;
    u32 sound;
    const char* unsupported;
} WebNetStateDigest;

WebNetStateDigest WebNetCaptureDigest(int inspect_payloads);
u32 WebNetCaptureBytes(u8* output, u32 capacity);

#endif
