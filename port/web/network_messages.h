#ifndef TM4_WEB_NETWORK_MESSAGES_H
#define TM4_WEB_NETWORK_MESSAGES_H

#include "tm4_scalar.h"
#include <stdarg.h>

/* Visible HUD messages and pending predicted messages share the same queue layout. */
typedef struct WebScreenMessageQueue {
    s32 count;
    s32 timer;
    char messages[3][64];
} WebScreenMessageQueue;

void WebScreenMessagesReset(WebScreenMessageQueue* visible, s32 limit);
void WebScreenMessageRegisterV(
    WebScreenMessageQueue* visible, const char* format, va_list arguments);
void WebScreenBeginPredictedTick(u32 tick);
void WebScreenFinishPredictedTick(void);
int WebNetConfirmPresentationTick(u32 tick);

#endif
