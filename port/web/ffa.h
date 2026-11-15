#ifndef TM4_WEB_FFA_H
#define TM4_WEB_FFA_H

#include "match_mode.h"

int WebFfaActive(void);
void WebFfaCarRemoved(int slot);
void WebFfaCompleteTick(void);
WebMatchResult WebFfaCapture(void);
void WebFfaRestore(WebMatchResult result);
struct WebParticipantState;
int WebFfaResultValid(
    WebMatchResult result, u32 tick, u32 slots, const struct WebParticipantState* participants);

#endif
