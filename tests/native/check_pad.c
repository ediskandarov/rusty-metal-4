#include "tm4/main/pad.h"
#include "tm4/main/registry.h"
#include <SDL3/SDL_gamepad.h>
#include <SDL3/SDL_keyboard.h>
#include <assert.h>
#include <libetc.h>
#include <psyz/input.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static SDL_JoystickID device_order[4] = { 1, 2, 3, 4 };
static bool keys[SDL_SCANCODE_COUNT];
static bool buttons[4][SDL_GAMEPAD_BUTTON_COUNT];
static Sint16 axes[4][SDL_GAMEPAD_AXIS_COUNT];
static int gamepad_count;
static s32 clock_ticks;
static Uint16 strong[4], weak[4];
static const struct {
    u8 small_ticks, ramp_ticks, start, end;
    s32 priority;
} vibrations[] = {
    { 3, 4, 200, 40, 4 },
    { 0, 4, 50, 50, 5 },
    { 0, 2, 100, 100, 2 },
    { 1, 0, 0, 0, 3 },
};

s32 GetCurrentTime(void)
{
    return clock_ticks;
}
RegistryDirectory* RegGetDirectoryPtrS(char* path)
{
    assert(strcmp(path, "/dualShock") == 0);
    return (RegistryDirectory*)vibrations;
}
void* RegGetFileDataPS(RegistryDirectory* directory, char* path)
{
    assert(directory == (RegistryDirectory*)vibrations);
    return strcmp(path, "test") == 0 ? (void*)vibrations : NULL;
}
bool SDL_RumbleGamepad(SDL_Gamepad* pad, Uint16 low, Uint16 high, Uint32 duration)
{
    int index = (uintptr_t)pad - 1;
    assert(index >= 0 && index < 4);
    strong[index] = low;
    weak[index] = high;
    return true;
}
void PadInit(int mode)
{
    (void)mode;
}
SDL_JoystickID* SDL_GetGamepads(int* count)
{
    *count = gamepad_count;
    SDL_JoystickID* ids = calloc(gamepad_count + 1, sizeof(*ids));
    memcpy(ids, device_order, gamepad_count * sizeof(*ids));
    return ids;
}
SDL_Gamepad* SDL_GetGamepadFromID(SDL_JoystickID id)
{
    for (int i = 0; i < gamepad_count; ++i) {
        if (device_order[i] == id)
            return (SDL_Gamepad*)(uintptr_t)id;
    }
    return NULL;
}
bool SDL_GetGamepadButton(SDL_Gamepad* pad, SDL_GamepadButton button)
{
    return buttons[(uintptr_t)pad - 1][button];
}
Sint16 SDL_GetGamepadAxis(SDL_Gamepad* pad, SDL_GamepadAxis axis)
{
    return axes[(uintptr_t)pad - 1][axis];
}
const bool* SDL_GetKeyboardState(int* count)
{
    if (count)
        *count = SDL_SCANCODE_COUNT;
    return keys;
}
void SDL_free(void* pointer)
{
    free(pointer);
}
void Psyz_PadsGet(int port, char* output, int size)
{
    assert(port == 0 && size == PSYZ_PAD_BUF_LEN);
    memset(output, 255, size);
}

int main(void)
{
    PadInitPad();
    assert(PadJpad[0].port_id == -1);
    keys[SDL_SCANCODE_X] = true;
    assert(PadGetPad(8) == PADRdown);
    assert(PadJpad[0].pressed_buttons == PADRdown && !PadJpad[0].has_analog);
    assert(PadJpad[1].port_id == -1);
    PadGetPad(8);
    assert(PadJpad[0].pressed_buttons == 0);
    keys[SDL_SCANCODE_X] = false;
    PadGetPad(8);
    assert(PadJpad[0].released_buttons == PADRdown);
    keys[SDL_SCANCODE_UP] = keys[SDL_SCANCODE_DOWN] = true;
    keys[SDL_SCANCODE_LEFT] = keys[SDL_SCANCODE_RIGHT] = true;
    assert(PadGetPad(8) == 0);
    memset(keys, 0, sizeof(keys));

    gamepad_count = 2;
    buttons[0][SDL_GAMEPAD_BUTTON_EAST] = true;
    buttons[1][SDL_GAMEPAD_BUTTON_START] = true;
    axes[0][SDL_GAMEPAD_AXIS_RIGHTX] = 32767;
    axes[0][SDL_GAMEPAD_AXIS_RIGHTY] = -32768;
    axes[0][SDL_GAMEPAD_AXIS_LEFTX] = -24576;
    axes[0][SDL_GAMEPAD_AXIS_LEFTY] = 24576;
    assert((u32)PadGetPad(8) == ((u32)PADstart << 16 | PADRright));
    assert(PadJpad[0].has_analog && PadJpad[1].has_analog);
    assert(PadJpad[0].port_id == 0 && PadJpad[1].port_id == 16);
    assert(PadJpad[0].axes[0] == 255 && PadJpad[0].axes[1] == 0);
    assert(PadJpad[0].axes[2] == 32 && PadJpad[0].axes[3] == 224);
    PadGetPad(8);
    assert(memcmp(PadJpad[0].axes, PadJpad[0].previous_axes, 4) == 0);
    keys[SDL_SCANCODE_E] = true;
    PadGetPad(8);
    assert(PadJpad[0].buttons == (PADRright | PADR2));
    keys[SDL_SCANCODE_E] = false;

    gamepad_count = 4;
    buttons[2][SDL_GAMEPAD_BUTTON_SOUTH] = true;
    buttons[3][SDL_GAMEPAD_BUTTON_START] = true;
    axes[2][SDL_GAMEPAD_AXIS_LEFTX] = axes[3][SDL_GAMEPAD_AXIS_LEFTX] = 16384;
    PadGetPad(8);
    assert(PadJpad[2].port_id == 1 && PadJpad[3].port_id == 17);
    assert(PadJpad[2].buttons == PADRdown && PadJpad[3].buttons == PADstart);
    assert(PadJpad[2].axes[2] == 192 && PadJpad[3].axes[2] == 192);
    PadInitVibrationDirectory();
    PadSetVibrationEnabled(2, 1);
    PadVibrateNamed(2, "test");
    assert(strong[2] == 200 * 257 && weak[2] == 65535);
    PadGetPad(8);
    assert(strong[2] == 200 * 257 && weak[2] == 65535);
    assert(strong[0] == 0 && strong[1] == 0 && strong[3] == 0);
    clock_ticks = 1;
    PadVibrateTS(2, "test", 1); // Lower priority cannot replace the active ramp.
    PadGetPad(8);
    assert(strong[2] == 160 * 257 && weak[2] == 65535);
    clock_ticks = 3;
    PadGetPad(8);
    assert(strong[2] == 80 * 257 && weak[2] == 0);
    clock_ticks = 4;
    PadGetPad(8);
    assert(strong[2] == 0 && weak[2] == 0);
    PadVibrateNamed(2, "test");
    PadVibrateTS(2, "test", 2); // Higher priority replaces it.
    PadGetPad(8);
    assert(strong[2] == 100 * 257);
    PadResetVibration();
    assert(strong[2] == 0 && weak[2] == 0);
    PadVibrateNamed(2, "test");
    PadGetPad(8);
    assert(strong[2] == 0);
    PadSetVibrationEnabled(2, 1);
    PadVibrateTS(2, "test", 3);
    assert(weak[2] == 65535); // A one-tick effect must reach hardware before the next scan.
    ++clock_ticks;
    PadGetPad(8);
    assert(weak[2] == 0);
    // SDL enumeration order changes; identities and player order must not.
    gamepad_count = 3;
    device_order[0] = 4;
    device_order[1] = 1;
    device_order[2] = 3;
    PadGetPad(8);
    assert(PadJpad[0].port_id == 0 && PadJpad[0].buttons == PADRright);
    assert(PadJpad[1].port_id == 1 && PadJpad[1].buttons == PADRdown);
    assert(PadJpad[2].port_id == 17 && PadJpad[2].buttons == PADstart);
    assert(PadJpad[3].port_id == -1 && PadJpad[3].absent_ticks == 1);
    PadGetPad(8);
    assert(PadJpad[3].absent_ticks == 2);
    gamepad_count = 4;
    device_order[0] = 4;
    device_order[1] = 3;
    device_order[2] = 2;
    device_order[3] = 1;
    PadGetPad(8);
    assert(PadJpad[1].port_id == 16 && PadJpad[1].buttons == PADstart);
    assert(PadJpad[2].port_id == 1 && PadJpad[2].buttons == PADRdown);
    PadStopPad();
    PadInitPad();
    PadGetPad(8); // SDL enumeration order must not become the player order on restart.
    assert(PadJpad[0].port_id == 0 && PadJpad[0].buttons == PADRright);
    assert(PadJpad[1].port_id == 16 && PadJpad[1].buttons == PADstart);
    assert(PadJpad[2].port_id == 1 && PadJpad[2].buttons == PADRdown);
    assert(PadJpad[3].port_id == 17 && PadJpad[3].buttons == PADstart);
    gamepad_count = 3;
    PadGetPad(8); // First controller is now missing.
    keys[SDL_SCANCODE_X] = true;
    PadGetPad(8);
    assert(PadJpad[0].port_id == 16 && PadJpad[0].buttons == PADstart);
    gamepad_count = 4;
    PadGetPad(8);
    assert(PadJpad[0].port_id == 0 && PadJpad[0].buttons == (PADRright | PADRdown));
    gamepad_count = 0;
    PadGetPad(8);
    assert(!PadJpad[0].has_analog && PadJpad[0].axes[2] == 0);
    assert(PadJpad[0].buttons == PADRdown && PadJpad[1].port_id == -1);
    PadGetPad(1);
    assert(PadJpad[1].port_id == -1);
    assert(PadGetPad(0) == 0 && PadGetPad(-1) == 0);
    PadGetPad(99);
    assert(PadJpad[7].port_id == -1);
    puts(
        "PASS input edges/axes, four stable device slots, keyboard fallback, capacity, vibration timing/priority/reset");
}
