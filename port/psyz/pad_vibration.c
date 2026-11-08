#include "pad_vibration.h"
#include "tm4/fixed.h"
#include "tm4/main/pad.h"
#include "tm4/main/registry.h"
#include "tm4/main/system.h"

/* Resource requests and deadlines use the original simulation ticks. */
typedef struct PadVibrationRequest {
    u8 small_motor_ticks, ramp_ticks, start_strength, end_strength;
    s32 priority;
} PadVibrationRequest;

typedef struct WebPadMotor {
    SDL_JoystickID device;
    u8 enabled, small_motor, large_motor, initial_strength;
    u32 small_until, ramp_start, ramp_end, next_update;
    s32 ramp_step_q12;
    s16 priority;
} WebPadMotor;

static WebPadMotor motors[4];
static RegistryDirectory* vibration_directory;

static void send_motor(const WebPadMotor* motor)
{
    SDL_Gamepad* device = SDL_GetGamepadFromID(motor->device);
    if (device)
        SDL_RumbleGamepad(device, motor->large_motor * 257, motor->small_motor ? 65535 : 0, 100);
}

static void clear_motor(WebPadMotor* motor)
{
    SDL_Gamepad* device = SDL_GetGamepadFromID(motor->device);
    if (device)
        SDL_RumbleGamepad(device, 0, 0, 0);
    motor->small_motor = motor->large_motor = 0;
    motor->small_until = motor->next_update = (u32)-1;
    motor->priority = 255;
}

static WebPadMotor* motor_for_player(s32 index)
{
    if (index < 0 || index >= 8 || PadJpad[index].port_id < 0)
        return NULL;
    s32 port = PadJpad[index].port_id;
    s32 slot = (port >> 4) + (port & 15) * 2;
    return slot < 4 ? &motors[slot] : NULL;
}

void PadInitVibrationDirectory(void)
{
    vibration_directory = RegGetDirectoryPtrS("/dualShock");
}

void PadResetVibration(void)
{
    for (s32 i = 0; i < 4; ++i) {
        clear_motor(&motors[i]);
        motors[i].enabled = 0;
    }
}

void PadSetVibrationEnabled(s32 index, u8 enabled)
{
    WebPadMotor* motor = motor_for_player(index);
    if (!motor)
        return;
    motor->enabled = enabled;
    if (!enabled)
        clear_motor(motor);
}

static void apply_vibration(s32 index, const PadVibrationRequest* request)
{
    WebPadMotor* motor = motor_for_player(index);
    if (!motor || !motor->enabled || !request)
        return;
    u32 now = GetCurrentTime();
    if (request->small_motor_ticks) {
        motor->small_motor = 1;
        motor->small_until = now + request->small_motor_ticks;
    }
    if (request->ramp_ticks && motor->priority >= request->priority) {
        motor->priority = request->priority;
        motor->initial_strength = motor->large_motor = request->start_strength;
        motor->ramp_step_q12
            = Q12Div(request->end_strength - request->start_strength, request->ramp_ticks);
        motor->ramp_start = now;
        motor->ramp_end = now + request->ramp_ticks;
        motor->next_update = now + 1;
    }
    /* LIBPAD sees actuator writes immediately; one-tick pulses expire at the next poll. */
    send_motor(motor);
}

void PadVibrateNamed(s32 index, char* path)
{
    if (vibration_directory)
        apply_vibration(index, RegGetFileDataPS(vibration_directory, path));
}

void PadVibrateTS(s32 index, char* path, s32 request_index)
{
    if (!vibration_directory)
        return;
    const PadVibrationRequest* requests = RegGetFileDataPS(vibration_directory, path);
    if (requests)
        apply_vibration(index, &requests[request_index]);
}

void WebPadUpdateVibration(const SDL_JoystickID* devices, int count)
{
    u32 now = GetCurrentTime();
    for (s32 i = 0; i < 4; ++i) {
        WebPadMotor* motor = &motors[i];
        SDL_JoystickID id = i < count ? devices[i] : 0;
        if (id != motor->device) {
            clear_motor(motor);
            motor->device = id;
        }
        if (!motor->enabled || !id)
            continue;
        if (now >= motor->small_until) {
            motor->small_motor = 0;
            motor->small_until = (u32)-1;
        }
        if (now >= motor->next_update) {
            if (now >= motor->ramp_end) {
                motor->next_update = (u32)-1;
                motor->large_motor = 0;
                motor->priority = 255;
            } else {
                u32 delta_q12 = motor->ramp_step_q12 * (now - motor->ramp_start);
                motor->large_motor = motor->initial_strength + Q12ToInt(delta_q12);
                motor->next_update = now + 1;
            }
        }
        send_motor(motor);
    }
}
