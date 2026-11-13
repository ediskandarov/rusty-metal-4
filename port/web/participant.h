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

enum { WebCarActive, WebCarWaiting, WebCarScheduled, WebCarSpawnFailed };
typedef struct WebParticipantRespawn {
    u32 state, due_tick, retry_ticks, remaining, attempts;
} WebParticipantRespawn;

typedef struct WebParticipantState {
    WebParticipantResult slots[8];
    WebParticipantRespawn respawns[8];
    /* One-based index into the immutable, prepared startup car list. */
    u32 models[8];
} WebParticipantState;

struct Car;
WebParticipantId WebParticipantIdentity(s32 slot);
WebParticipantId WebParticipantObjectIdentity(const void* object);
void WebParticipantCarRemoved(const struct Car* car);
/* Mode policies call this at deterministic tick boundaries, only after removal. */
int WebParticipantScheduleRespawn(s32 slot, u32 due_tick, u32 retry_ticks, u32 attempts);
void WebParticipantProcessRespawns(void);
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
