#ifndef TM4_WEB_NET_MATCH_H
#define TM4_WEB_NET_MATCH_H

int WebNetMatchStartPending(void);
int WebNetMatchActive(void);
int WebNetMatchCancelled(void);
int WebNetMatchViewSlot(void);
void WebNetMatchPollInput(void);
void WebNetMatchSeed(void);
int WebNetMatchTakeInput(void);
void WebNetMatchPublishTick(void);
void WebNetMatchEnd(void);

#endif
