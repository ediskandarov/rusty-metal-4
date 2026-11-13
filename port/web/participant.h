#ifndef TM4_WEB_PARTICIPANT_H
#define TM4_WEB_PARTICIPANT_H

#include <libgte.h>
#include "tm4_scalar.h"

/* Fixed-width identity is copied into effects, never resolved through a car or slot. */
typedef struct WebParticipantId {
    u32 low, high;
} WebParticipantId;

typedef struct WebParticipantResult {
    WebParticipantId id;
    s32 frags, deaths;
} WebParticipantResult;

typedef struct WebParticipantState {
    WebParticipantResult slots[8];
} WebParticipantState;

struct Car;
WebParticipantId WebParticipantIdentity(s32 slot);
WebParticipantId WebParticipantObjectIdentity(const void* object);
void WebParticipantRecordDeath(const struct Car* victim, WebParticipantId source);
struct Anim;
struct Tm4CollisionPolygon;
void WebCarIgniteFromParticipant(struct Car* car, struct Anim* contact, WebParticipantId source);
void WebIgniteTerrain(struct Tm4CollisionPolygon* polygon, SVECTOR* point, WebParticipantId source);
int WebParticipantParse(WebParticipantState* state, u32 mask, const char* identities);
int WebParticipantStateValid(const WebParticipantState* state, u32 mask);
void WebParticipantCapture(WebParticipantState* state);
void WebParticipantRestore(const WebParticipantState* state);

#endif
