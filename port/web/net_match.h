#ifndef TM4_WEB_NET_MATCH_H
#define TM4_WEB_NET_MATCH_H

int WebNetLocalViewCount(void);
int WebNetGameplaySlot(int view);
int WebNetLocalView(int slot);
int WebDirectStartup(void);
int WebAuthorityStartup(void);
void WebNetPublishCatalog(void);
int WebNetMatchActive(void);
int WebNetReplaying(void);
int WebNetRenderedPrediction(void);
int WebNetPortableCheckpointEnabled(void);
int WebNetLocalCheckpointSupported(void);
void WebNetSuppressReplayedSounds(void);
int WebNetMatchViewSlot(void);
void WebNetMatchPollInput(void);
void WebNetMatchSeed(void);
int WebNetMatchTakeInput(void);
void WebNetMatchPublishTick(void);
void WebNetMatchEnd(void);

#endif
