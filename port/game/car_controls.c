#include "src/modules/car/private.h"

s32 CarControlsConstructor(Car* car, s32 type)
{
    s32* value;
    s32 controller;
    value = CarGetFileData(CarTextDigitalSteeringMaxSpeed);
    if (!value)
        return 0;
    car->controls.digital_steering_max_speed = *value;
    if (car->controls.digital_steering_max_speed < 0)
        car->controls.digital_steering_max_speed = 0;
    value = CarGetFileData(CarTextDigitalSteeringFullTurnTime);
    if (!value)
        return 0;
    car->controls.digital_steering_turn_step = 65536 / Q12MulRound(*value, SIMULATION_FPS);
    value = CarGetFileData(CarTextDigitalSteeringFullReturnTime);
    if (!value)
        return 0;
    car->controls.digital_steering_return_step = 65536 / Q12MulRound(*value, SIMULATION_FPS);
    car->controls.brake_input = 15;
    car->controls.gear = CAR_GEAR_FIRST;
    car->controls.input_device = 65;
    car->controls.input_flags = 192;
    car->controls.action = CarActionNone;
    car->controls.steering_input = 0;
    car->controls.throttle_input = 0;
    car->controls.machine_gun_active = 0;
    car->controls.turbo_active = 0;
    car->controls.turbo_tap_ticks = 0;
    car->controls.ebrake_active = 0;
    if (type == CAR_CONTROL_PLAYER) {
        controller = car->controller_index;
        car->controls.analog_steering_scale = 0x10000000
            / (GameInfo.players[controller].bindings[1].axes[2].full_scale
                - GameInfo.players[controller].bindings[1].axes[2].deadzone);
        car->controls.analog_throttle_scale_3 = 0xf000
            / (GameInfo.players[controller].bindings[1].axes[0].full_scale
                - GameInfo.players[controller].bindings[1].axes[0].deadzone);
        car->controls.analog_throttle_scale_1 = 0xf000
            / (GameInfo.players[controller].bindings[1].axes[1].full_scale
                - GameInfo.players[controller].bindings[1].axes[1].deadzone);
    }
    return 1;
}
