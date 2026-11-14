#ifndef TM4_WEB_FFA_H
#define TM4_WEB_FFA_H

#include "tm4_scalar.h"

/* A result names every tied leader by occupied gameplay slot. Reasons are a bitset:
 * 1 = elapsed simulation time, 2 = frag threshold, 3 = both in the same tick. */
typedef struct WebFfaResult {
    u32 tick, reasons, winners;
} WebFfaResult;

int WebFfaActive(void);
void WebFfaCarRemoved(int slot);
void WebFfaCompleteTick(void);
WebFfaResult WebFfaCapture(void);
void WebFfaRestore(WebFfaResult result);
struct WebParticipantState;
int WebFfaResultValid(WebFfaResult result, u32 tick, u32 slots,
    const struct WebParticipantState* participants);

#endif
