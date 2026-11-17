#ifndef TM4_WEB_NET_MATCH_H
#define TM4_WEB_NET_MATCH_H

struct WebParticipantState;
struct Car;
void WebNetCarLeaving(struct Car* car);
void WebNetInitialParticipantIds(unsigned int output[16]);
unsigned int WebNetParticipantIdentityPart(int slot, int part);
/* Authoritative events apply before inputs at the named simulation boundary. */
/* Read-only preconditions distinguish invalid admission from failed car preparation. */
int WebNetAdmissionValid(
    unsigned int tick, int slot, unsigned int low, unsigned int high, const char* model);
int WebNetAdmitParticipant(
    unsigned int tick, int slot, unsigned int low, unsigned int high, const char* model);
int WebNetDepartParticipant(unsigned int tick, int slot, unsigned int low, unsigned int high);
int WebNetParticipantModelsValid(const struct WebParticipantState* state, unsigned int slots);
void WebNetRestoreParticipantConfiguration(void);
unsigned int WebNetFfaRespawnDelay(void);
unsigned int WebNetFfaTimeLimit(void);
unsigned int WebNetFfaFragLimit(void);
int WebNetDeparting(void);
unsigned int WebNetModelCount(void);
char* WebNetModelName(unsigned int index);
void WebNetModelPool(char output[8][64]);
int WebNetSlotCapacity(void);
/* Entrant storage includes original Tournament waves and bosses, not just controllers. */
int WebNetCarCapacity(void);
int WebNetSlotMask(void);
int WebNetParticipantSlot(int index);
int WebNetParticipantControlKind(int slot);
unsigned int WebNetBotSlots(void);
const char* WebNetAiBlocker(void);
int WebNetSlotOccupied(int slot);
int WebNetLocalViewCount(void);
int WebNetGameplaySlot(int view);
int WebNetLocalView(int slot);
int WebDirectStartup(void);
int WebSimulationOnly(void);
void WebNetPublishCatalog(void);
int WebNetMatchActive(void);
int WebNetTournament(void);
int WebNetReplaying(void);
int WebNetRenderedPrediction(void);
int WebNetPortableCheckpointEnabled(void);
int WebNetLocalCheckpointSupported(void);
const char* WebNetCapturePortableInto(
    unsigned char* output, unsigned int capacity, unsigned int* length);
const char* WebNetRestorePortableFrom(const unsigned char* input, unsigned int length);
int WebNetMatchViewSlot(void);
void WebNetMatchPollInput(void);
void WebNetMatchSeed(void);
int WebNetMatchTakeInput(void);
void WebNetMatchPublishTick(void);
void WebNetMatchEnd(void);

#endif
