#ifndef TM4_WEB_MATCH_MODE_H
#define TM4_WEB_MATCH_MODE_H
#include "tm4_scalar.h"
/* Completion causes: time, frags, tournament victory, tournament defeat. */
typedef struct WebMatchResult {
    u32 tick, reasons, winners;
} WebMatchResult;
struct WebParticipantState;
WebMatchResult WebMatchCapture(void);
void WebMatchRestore(WebMatchResult result);
void WebMatchCompleteTick(void);
int WebMatchResultValid(
    WebMatchResult result, u32 tick, u32 slots, const struct WebParticipantState* participants);
#endif
