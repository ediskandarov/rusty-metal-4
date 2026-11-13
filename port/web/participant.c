#include "participant.h"

#include "net_match.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"
#include "tm4/main/object.h"
#include "tm4/modules/car.h"

#include <limits.h>
#include <string.h>

enum { MaxRespawnAttempts = 8, MaxRespawnRetryTicks = 3600 };

static WebParticipantState participants;

static int equal(WebParticipantId first, WebParticipantId second)
{
    return first.low == second.low && first.high == second.high;
}

static int present(WebParticipantId id) { return id.low || id.high; }

WebParticipantId WebParticipantIdentity(s32 slot)
{
    return WebNetSlotOccupied(slot) ? participants.slots[slot].id : (WebParticipantId) { 0 };
}

WebParticipantId WebParticipantObjectIdentity(const void* object)
{
    return object ? ObjectGetHeader(object)->participant : (WebParticipantId) { 0 };
}

void WebParticipantRecordDeath(const Car* victim, WebParticipantId source)
{
    if (!WebNetMatchActive())
        return;
    const WebParticipantId dead = WebParticipantObjectIdentity(victim);
    const WebParticipantId attacker = source;
    if (!present(dead))
        return;
    for (s32 slot = 0; slot < 8; ++slot) {
        WebParticipantResult* result = &participants.slots[slot];
        if (equal(result->id, dead) && result->deaths < INT_MAX)
            ++result->deaths;
        /* Environmental damage and suicide do not award a frag. This is a
         * combat statistic; Deathmatch still owns its original round scoring. */
        if (present(attacker) && !equal(attacker, dead) && equal(result->id, attacker)
            && result->frags < INT_MAX)
            ++result->frags;
    }
}

void WebParticipantCarRemoved(const Car* car)
{
    if (WebNetMatchActive() && WebNetSlotOccupied(car->controller_index)
        && equal(WebParticipantObjectIdentity(car), WebParticipantIdentity(car->controller_index)))
        participants.respawns[car->controller_index]
            = (WebParticipantRespawn) { .state = WebCarWaiting };
}

int WebParticipantScheduleRespawn(s32 slot, u32 due_tick, u32 retry_ticks, u32 attempts)
{
    if (!WebNetMatchActive() || !WebNetSlotOccupied(slot) || GameInfo.players[slot].car
        || !GameInfo.active || GameInfo.mode != GAME_MODE_PLAY || GameInfo.next_mode
        || GameInfo.deathmatch_finished || participants.respawns[slot].state != WebCarWaiting
        || !attempts || attempts > MaxRespawnAttempts || !retry_ticks
        || retry_ticks > MaxRespawnRetryTicks || due_tick < (u32)MainFrameCount
        || due_tick > INT_MAX - retry_ticks * attempts)
        return 0;
    participants.respawns[slot] = (WebParticipantRespawn) { .state = WebCarScheduled,
        .due_tick = due_tick,
        .retry_ticks = retry_ticks,
        .remaining = attempts };
    return 1;
}

void WebParticipantProcessRespawns(void)
{
    if (!WebNetMatchActive())
        return;
    for (s32 slot = 0; slot < 8; ++slot) {
        WebParticipantRespawn* pending = &participants.respawns[slot];
        if (pending->state != WebCarScheduled)
            continue;
        if (!GameInfo.active || GameInfo.next_mode || GameInfo.deathmatch_finished) {
            *pending = (WebParticipantRespawn) { .state = WebCarWaiting };
            continue;
        }
        if (pending->due_tick > (u32)MainFrameCount)
            continue;
        ++pending->attempts;
        --pending->remaining;
        for (s32 entrant = 0; entrant < GameInfo.player_car_count; ++entrant) {
            if (WebNetParticipantSlot(entrant) == slot) {
                GameSpawnCar(entrant, 0, 0, 0, 0, 0, 0, 0);
                break;
            }
        }
        if (GameInfo.players[slot].car)
            *pending = (WebParticipantRespawn) { .state = WebCarActive };
        else if (pending->remaining)
            pending->due_tick = (u32)MainFrameCount + pending->retry_ticks;
        else {
            pending->state = WebCarSpawnFailed;
            pending->due_tick = 0;
        }
    }
}

int WebParticipantStateValid(const WebParticipantState* state, u32 mask)
{
    for (s32 slot = 0; slot < 8; ++slot) {
        const WebParticipantResult* result = &state->slots[slot];
        if (present(result->id) != !!(mask & (1u << slot))
            || ((mask & (1u << slot)) ? !state->models[slot] || state->models[slot] > 8
                                      : state->models[slot] != 0)
            || result->frags < 0 || result->deaths < 0
            || (!(mask & (1u << slot)) && (result->frags || result->deaths)))
            return 0;
        const WebParticipantRespawn* pending = &state->respawns[slot];
        if (pending->state > WebCarSpawnFailed || pending->attempts > MaxRespawnAttempts
            || pending->remaining > MaxRespawnAttempts
            || pending->attempts + pending->remaining > MaxRespawnAttempts
            || (pending->state == WebCarScheduled
                && (!pending->remaining || !pending->retry_ticks
                    || pending->retry_ticks > MaxRespawnRetryTicks
                    || pending->due_tick > INT_MAX - pending->retry_ticks * pending->remaining))
            || ((pending->state == WebCarActive || pending->state == WebCarWaiting)
                && (pending->due_tick || pending->retry_ticks || pending->remaining
                    || pending->attempts))
            || (pending->state == WebCarSpawnFailed
                && (pending->due_tick || pending->remaining || !pending->attempts
                    || !pending->retry_ticks || pending->retry_ticks > MaxRespawnRetryTicks))
            || (!(mask & (1u << slot))
                && memcmp(pending, &(WebParticipantRespawn) { 0 }, sizeof(*pending))))
            return 0;
        for (s32 previous = 0; previous < slot; ++previous)
            if (present(result->id) && equal(result->id, state->slots[previous].id))
                return 0;
    }
    return 1;
}

int WebParticipantParse(WebParticipantState* state, u32 mask, const char* identities)
{
    memset(state, 0, sizeof(*state));
    if (!identities)
        return 0;
    const char* cursor = identities;
    for (s32 slot = 0; slot < 8; ++slot) {
        if (!(mask & (1u << slot)))
            continue;
        WebParticipantId id = { 0 };
        for (s32 digit = 0; digit < 16; ++digit) {
            const char ch = *cursor++;
            if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')))
                return 0;
            id.high = (id.high << 4) | (id.low >> 28);
            id.low = (id.low << 4) | (ch <= '9' ? ch - '0' : ch - 'a' + 10);
        }
        state->slots[slot].id = id;
        state->models[slot] = __builtin_popcount(mask & ((1u << slot) - 1)) + 1;
        if (mask >> (slot + 1)) {
            if (*cursor++ != '\n')
                return 0;
        } else if (*cursor)
            return 0;
    }
    return WebParticipantStateValid(state, mask);
}

void WebParticipantCapture(WebParticipantState* state) { *state = participants; }
void WebParticipantRestore(const WebParticipantState* state) { participants = *state; }
