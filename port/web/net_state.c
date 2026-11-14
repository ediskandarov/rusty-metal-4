#include "net_state.h"
#include "interpolation.h"
#include "net_match.h"
#include "net_state_fields.h"
#include "participant.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"
#include "tm4/main/pad.h"
#include "tm4/main/system.h"

enum { InitialHash = 2166136261u };

static WebNetStateDigest capture(StateBytes* bytes, int inspect_payloads)
{
    WebNetStateDigest result = {
        .session = InitialHash,
        .cars = InitialHash,
        .objects = InitialHash,
        .world = InitialHash,
        .sound = InitialHash,
    };
    NetStateOutput output = { .checksum = &result.session, .bytes = bytes };
    NetStateOutput* hash = &output;
    VALUE(12); /* State record schema. */
    VALUE(WebNetFfaRespawnDelay());
    const Tm4GameInfo* game = &GameInfo;
    WebParticipantState participants;
    WebParticipantCapture(&participants);
    VALUE(randseed());
    VALUE(WebRenderEffectRandomState());
    VALUE(MainFrameCount);
    key(hash, game->world_name);
    VALUE(game->random_seed);
    VALUE(game->active);
    VALUE(game->game_type);
    VALUE(game->player_car_count);
    VALUE(WebNetSlotCapacity());
    VALUE(WebNetSlotMask());
    VALUE(game->computer_count);
    VALUE(game->mode);
    VALUE(game->next_mode);
    VALUE(game->car_count);
    VALUE(game->active_player_count);
    VALUE(game->deathmatch_winner);
    VALUE(game->deathmatch_finished);
    VALUE(game->deathmatch_next_mode);
    VALUE(game->deathmatch_accept_input);
    VALUE(game->deathmatch_rounds);
    for (s32 slot = 0; slot < game->player_car_count; ++slot) {
        const s32 actual_slot = WebNetParticipantSlot(slot);
        VALUE(actual_slot);
        const Tm4GamePlayer* player = &game->players[actual_slot];
        const PadCache* pad = &PadJpad[actual_slot];
        VALUE(participants.models[actual_slot]);
        VALUE(participants.slots[actual_slot].id.low);
        VALUE(participants.slots[actual_slot].id.high);
        VALUE(participants.slots[actual_slot].frags);
        VALUE(participants.slots[actual_slot].deaths);
        VALUE(participants.respawns[actual_slot].state);
        VALUE(participants.respawns[actual_slot].due_tick);
        VALUE(participants.respawns[actual_slot].retry_ticks);
        VALUE(participants.respawns[actual_slot].remaining);
        VALUE(participants.respawns[actual_slot].attempts);
        VALUE(player->lives);
        VALUE(player->wins);
        VALUE(player->losses);
        VALUE(player->eliminated);
        VALUE(handle(player->car));
        VALUE(pad->device_type);
        VALUE(pad->has_analog);
        VALUE(pad->buttons);
        VALUE(pad->previous_buttons);
        VALUE(pad->pressed_buttons);
        VALUE(pad->released_buttons);
        VALUE(pad->idle_ticks);
        for (unsigned axis = 0; axis < ArrayCount(pad->axes); ++axis) {
            VALUE(pad->axes[axis]);
            VALUE(pad->previous_axes[axis]);
        }
    }

    output.checksum = &result.cars;
    result.unsupported = WebNetWriteCars(hash);

    output.checksum = &result.objects;
    VALUE(ObjectNextSerial);
    for (unsigned list = 0; list < OBJECT_LIST_COUNT; ++list) {
        output.checksum = list == OBJECT_LIST_SOUND ? &result.sound : &result.objects;
        VALUE(list);
        for (const Tm4ObjectHeader* object = ObjectLists[list].first; object;
             object = object->next) {
            if (!WebNetWriteObject(hash, object, inspect_payloads) && !result.unsupported)
                result.unsupported = object->name;
        }
        VALUE(0);
    }

    output.checksum = &result.world;
    for (const Tm4WorldSquare* cell = ObjectActiveInteractionCells; cell;
         cell = cell->active_next) {
        VALUE(cell - WorldSquares + 1);
        for (const Tm4ObjectHeader* object = cell->interaction_objects; object;
             object = object->next_interaction)
            VALUE(object->serial + 1u);
        VALUE(0);
    }
    VALUE(0);
    const s32 polygon_count = WebNetWorldPolygonCount();
    VALUE(polygon_count);
    for (s32 i = 0; i < polygon_count; ++i) {
        const Tm4CollisionPolygon* polygon = &WorldCollisionPolygons[i];
        VALUE(CollisionPolygonEnabled(polygon));
        VALUE(handle(polygon->owner));
    }
    return result;
}

WebNetStateDigest WebNetCaptureDigest(int inspect_payloads)
{
    return capture(NULL, inspect_payloads);
}

u32 WebNetCaptureBytes(u8* output, u32 capacity)
{
    StateBytes bytes = { .data = output, .capacity = capacity };
    const WebNetStateDigest state = capture(&bytes, 1);
    return (bytes.overflow || state.unsupported) ? 0 : bytes.length;
}
