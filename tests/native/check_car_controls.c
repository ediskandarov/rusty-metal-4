/* Exercise the port-owned constructor with registry settings and player bindings. */
#include "src/modules/car/private.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

Tm4GameInfo GameInfo;
char CarTextDigitalSteeringMaxSpeed[] = "maxSpeed";
char CarTextDigitalSteeringFullTurnTime[] = "turnTime";
char CarTextDigitalSteeringFullReturnTime[] = "returnTime";
static s32 settings[3] = { 120, 4096, 8192 };
static int missing = -1;
static int requests;

void* CarGetFileData(char* path)
{
    char* names[] = { CarTextDigitalSteeringMaxSpeed, CarTextDigitalSteeringFullTurnTime,
        CarTextDigitalSteeringFullReturnTime };
    for (int i = 0; i < 3; ++i) {
        if (!strcmp(path, names[i])) {
            ++requests;
            return i == missing ? NULL : &settings[i];
        }
    }
    assert(0 && "unexpected registry setting");
    return NULL;
}

static void defaults(const Car* car)
{
    assert(car->controls.digital_steering_max_speed == settings[0]);
    assert(car->controls.digital_steering_turn_step == 2184);
    assert(car->controls.digital_steering_return_step == 1092);
    assert(car->controls.brake_input == 15 && car->controls.gear == CAR_GEAR_FIRST);
    assert(car->controls.input_device == 65 && car->controls.input_flags == 192);
    assert(car->controls.action == CarActionNone);
    assert(car->controls.steering_input == 0 && car->controls.throttle_input == 0);
    assert(car->controls.machine_gun_active == 0 && car->controls.turbo_active == 0);
    assert(car->controls.turbo_tap_ticks == 0 && car->controls.ebrake_active == 0);
}

int main(void)
{
    Car car;
    memset(&car, 0x55, sizeof(car));
    car.controller_index = 3;
    GameInfo.players[3].bindings[1].axes[2].full_scale = 144;
    GameInfo.players[3].bindings[1].axes[2].deadzone = 16;
    GameInfo.players[3].bindings[1].axes[0].full_scale = 72;
    GameInfo.players[3].bindings[1].axes[0].deadzone = 8;
    GameInfo.players[3].bindings[1].axes[1].full_scale = 40;
    GameInfo.players[3].bindings[1].axes[1].deadzone = 8;
    assert(CarControlsConstructor(&car, CAR_CONTROL_PLAYER) == 1);
    assert(requests == 3);
    defaults(&car);
    assert(car.controls.analog_steering_scale == 2097152);
    assert(car.controls.analog_throttle_scale_3 == 960);
    assert(car.controls.analog_throttle_scale_1 == 1920);
    assert(car.controls.reverse == 0x55555555);
    assert(car.controller_index == 3);

    /* Non-player controls must not read a player's analog bindings. */
    memset(&car, 0x55, sizeof(car));
    car.controller_index = -1;
    assert(CarControlsConstructor(&car, CAR_CONTROL_ENEMY) == 1);
    defaults(&car);
    assert(car.controls.analog_steering_scale == 0x55555555);
    assert(car.controls.analog_throttle_scale_3 == 0x5555);
    assert(car.controls.analog_throttle_scale_1 == 0x5555);

    settings[0] = -12;
    assert(CarControlsConstructor(&car, CAR_CONTROL_ENEMY) == 1);
    assert(car.controls.digital_steering_max_speed == 0);
    settings[0] = 120;

    for (missing = 0; missing < 3; ++missing) {
        memset(&car, 0x55, sizeof(car));
        requests = 0;
        assert(CarControlsConstructor(&car, CAR_CONTROL_PLAYER) == 0);
        assert(requests == missing + 1);
        assert(car.controls.brake_input == 0x55555555);
    }
    puts("PASS: car control defaults, analog bindings, CPU initialization and missing settings");
    return 0;
}
