#include "net_state_fields.h"
#include "snapshot_types.h"
#include "src/modules/car/private.h"
#include "tm4/main/game.h"

static void controls(NetStateOutput* hash, const CarControls* input)
{
    VALUE(input->steering_input);
    VALUE(input->throttle_input);
    VALUE(input->brake_input);
    VALUE(input->reverse);
    VALUE(input->gear);
    VALUE(input->turbo_active);
    VALUE(input->turbo_tap_ticks);
    VALUE(input->ebrake_active);
    VALUE(input->machine_gun_active);
    VALUE(input->input_device);
    VALUE(input->input_flags);
    VALUE(input->action);
    for (unsigned i = 0; i < ArrayCount(input->input_history); ++i) {
        VALUE(input->input_history[i].buttons);
        VALUE(input->input_history[i].time);
    }
    VALUE(input->weapon_pressed);
    VALUE(input->weapon_held);
    VALUE(input->selected_weapon);
    VALUE(input->selected_weapon_slot);
}

static void car_state(NetStateOutput* hash, const Car* car)
{
    VALUE(handle(car));
    if (!car)
        return;
    key(hash, car->character_name);
    VALUE(car->frame);
    VALUE(car->index);
    VALUE(car->controller_index);
    VALUE(car->turbo_emitter_count);
    VALUE(car->health);
    VALUE(car->energy);
    VALUE(car->turbo_fuel);
    VALUE(car->turbo_amount);
    VALUE(car->fire_ticks);
    VALUE(car->burn_source.low);
    VALUE(car->burn_source.high);
    VALUE(car->freeze_ticks);
    VALUE(car->shield_ticks);
    VALUE(car->invisibility_ticks);
    VALUE(car->invisibility_hidden);
    VALUE(car->original_faces != NULL);
    VALUE(car->original_colors != NULL);
    /* Fade progress controls when its simulation object is destroyed. */
    if (car->original_faces) {
        s32 count = 0;
        for (s32 i = 0; i < car->display_list_count; ++i)
            count += car->display_lists[i].face_count;
        VALUE(count);
        for (s32 i = 0; i < count; ++i)
            VALUE(car->faces[i].reflection);
    }
    if (car->original_colors) {
        VALUE(car->normal_count);
        for (s32 i = 0; i < car->normal_count; ++i) {
            VALUE(car->colors[i].r);
            VALUE(car->colors[i].g);
            VALUE(car->colors[i].b);
            VALUE(car->colors[i].cd);
        }
    }
    VALUE(car->special_regeneration_ticks);
    VALUE(car->special_regeneration_interval);
    VALUE(car->muzzle_index);
    VALUE(car->muzzle_cooldown);
    VALUE(car->muzzle_emitted);
    VALUE(car->axle_torque);
    VALUE(car->wheel_friction_limit);
    VALUE(car->force_scale);
    VALUE(car->force_sum);
    VALUE(car->display_speed);
    VALUE(car->inverted_ticks);
    VALUE(car->recovery_ticks);
    VALUE(car->contact_count);
    VALUE(car->contact_countdown);
    VALUE(car->control_kind);
    VALUE(handle(car->ai.target));
    VALUE(handle(car->fire_effect));
    VALUE(handle(car->turbo_sound));
    VALUE(handle(car->invisibility_sound));
    VALUE(handle(car->freeze_sound));
    VALUE(handle(car->shield_sound));
    VALUE(handle(car->engine_sound));
    VALUE(handle(car->turbo_light));
    matrix(hash, &car->transform);
    matrix(hash, &car->previous_transform);
    XYZ(car->position);
    XYZ(car->previous_position);
    for (const CarParticle* p = car->particles; p < car->particle_end; ++p) {
        XYZ(p->previous_position);
        XYZ(p->position);
        XYZ(p->world_position_q12);
        XYZ(p->velocity_q12);
        XYZ(p->net_force);
        XYZ(p->spring_force);
        XYZ(p->external_force);
        VALUE(p->response_wheel ? p->response_wheel - car->wheels + 1 : 0);
        XYZ(p->normal);
        VALUE(p->contact_state);
        VALUE(p->material);
        XYZ(p->surface_velocity_q12);
        VALUE(p->slip_speed_q12);
        VALUE(p->gravity);
    }
    for (const CarWheel* w = car->wheels; w <= car->wheel_end; ++w) {
        VALUE(w->response_particle ? w->response_particle - car->particles + 1 : 0);
        XYZ(w->direction.vector);
        VALUE(w->direction.fields.displacement);
        VALUE(w->force);
        VALUE(w->velocity);
        VALUE(w->friction_limit);
        VALUE(w->torque);
        VALUE(w->angular_velocity);
        VALUE(w->rotation);
        VALUE(w->steering);
    }
    for (const CarSpring* s = car->springs; s < car->spring_end; ++s)
        XYZ(s->direction);
    controls(hash, &car->controls);
    for (s32 i = 0; i < CarWeaponCount; ++i) {
        const CarWeaponInstance* weapon = &car->weapons[i];
        key(hash, weapon->descriptor->name);
        VALUE(weapon->amount);
        VALUE(weapon->count);
        VALUE(weapon->index);
        VALUE(weapon->active);
        VALUE(weapon->next_time);
    }
    for (const CarCollisionHistory* node = car->collision_history; node; node = node->next) {
        VALUE(1);
        VALUE(handle(node->other));
        VALUE(node->time);
    }
    VALUE(0);
}

static const Car* detonation_weapon_owner(const CarWeaponInstance* weapon, s32* index)
{
    for (s32 car_index = 0; car_index < GameInfo.car_count; ++car_index) {
        const Car* car = GameInfo.cars[car_index];
        if (!car || !car->weapons)
            continue;
        for (s32 slot = 0; slot < CarWeaponCount; ++slot) {
            if (&car->weapons[slot] == weapon) {
                *index = slot;
                return car;
            }
        }
    }
    return NULL;
}

const char* WebNetWriteCars(NetStateOutput* hash)
{
    const char* unsupported = NULL;
    for (s32 i = 0; i < GameInfo.car_count; ++i) {
        const Car* car = GameInfo.cars[i];
        car_state(hash, car);
        if (!car)
            continue;
        const SnapshotType* type = WebSnapshotCarCallbackType(car);
        u8 state[256];
        const u32 length = type
            ? WebSnapshotFieldsCapture(type, car->callback_context, state, sizeof(state))
            : 0;
        if (!length) {
            unsupported = "car callback state";
            continue;
        }
        key(hash, type->name);
        for (u32 offset = 0; offset < length; ++offset)
            state_byte(hash, state[offset]);
    }
    for (const CarDetonationNode* node = CarDetonationDevices; node; node = node->next) {
        s32 slot = -1;
        const Car* owner = detonation_weapon_owner(node->weapon, &slot);
        u32 device = handle(node->object);
        u32 car = handle(owner);
        VALUE(device);
        VALUE(car);
        VALUE(slot);
        if (!device || device == UINT32_MAX || !car || car == UINT32_MAX)
            unsupported = "detonation device reference";
    }
    VALUE(0);
    return unsupported;
}
