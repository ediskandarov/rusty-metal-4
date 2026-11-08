#include "tm4/main/pad.h"
#include "pad_vibration.h"
#include <SDL3/SDL_gamepad.h>
#include <SDL3/SDL_keyboard.h>
#include <libetc.h>
#include <psyz/input.h>
#include <string.h>

#ifdef TM4_WEB_CONTROLS
#include "tm4/main/game.h"
#include <emscripten.h>
#endif

PadCache PadJpad[8];
static SDL_JoystickID player_devices[4];

#ifdef TM4_WEB_CONTROLS
extern Tm4GameInfo MenuGameState;

static bool browser_keyboard;
static bool input_blocked;
static u16 keyboard_buttons;
static u16 raw_buttons[4];
static u16 held_buttons[4];
static bool held_sticks[4];
static u8 gamepad_map[4][16];

EMSCRIPTEN_KEEPALIVE void WebSetKeyboardButtons(u16 buttons)
{
    browser_keyboard = true;
    keyboard_buttons = buttons;
}

EMSCRIPTEN_KEEPALIVE void WebSetInputBlocked(int blocked)
{
    if (input_blocked == !!blocked)
        return;
    input_blocked = !!blocked;
    for (s32 port = 0; port < 4; ++port) {
        /* Sample once after returning, even if no game tick ran while blocked. */
        held_buttons[port] = 0xffff;
        held_sticks[port] = true;
    }
}

EMSCRIPTEN_KEEPALIVE void WebMapGamepadButton(u32 port, u32 target, u32 source)
{
    if (port < 4 && target < 16 && source < 16)
        gamepad_map[port][target] = source + 1;
}

EMSCRIPTEN_KEEPALIVE u32 WebGetInputDevice(u32 port)
{
    return port < 4 ? player_devices[port] : 0;
}

EMSCRIPTEN_KEEPALIVE u32 WebGetPhysicalButtons(u32 port)
{
    return port < 4 && player_devices[port] ? raw_buttons[port] : 0;
}

EMSCRIPTEN_KEEPALIVE u32 WebGetControlAction(u32 player, u32 action)
{
    if (player >= 4 || action >= GameControlCount)
        return 0;
    const Tm4GameInfo* game = &GameInfo;
    if (GameInfo.mode == GAME_MODE_MENU && MenuGameState.player_count)
        game = &MenuGameState;
    return game->players[player].bindings[!!player_devices[player]].actions[action];
}

#ifdef TM4_WEB_TEST_HOOKS
EMSCRIPTEN_KEEPALIVE u32 WebTestGetPadButtons(u32 port)
{
    if (port >= 4)
        return 0;
    s32 port_id = ((port & 1) << 4) | (port >> 1);
    for (s32 i = 0; i < 8; ++i) {
        if (PadJpad[i].port_id == port_id)
            return PadJpad[i].buttons;
    }
    return 0;
}
#endif

static u16 map_gamepad_buttons(s32 port, u16 pressed, char* axes)
{
    raw_buttons[port] = pressed;
    if (input_blocked) {
        held_buttons[port] = 0xffff;
        held_sticks[port] = true;
    } else {
        held_buttons[port] &= pressed;
        if (held_sticks[port]) {
            /* Ignore ordinary resting drift while waiting for both sticks. */
            bool centered = true;
            for (s32 i = 0; i < 4; ++i) {
                u8 axis = axes[i];
                centered &= axis >= 112 && axis <= 144;
            }
            held_sticks[port] = !centered;
        }
    }
    if (held_sticks[port])
        memset(axes, 128, 4);
    pressed &= ~held_buttons[port];
    u16 mapped = 0;
    for (s32 target = 0; target < 16; ++target) {
        s32 source = gamepad_map[port][target];
        if (pressed & (1u << (source ? source - 1 : target)))
            mapped |= 1u << target;
    }
    return mapped;
}
#endif


static void clear_pad(PadCache* pad)
{
    u32 absent_ticks = pad->absent_ticks;
    u32 idle_ticks = pad->idle_ticks;
    memset(pad, 0, sizeof(*pad));
    pad->port_id = -1;
    pad->absent_ticks = absent_ticks + 1;
    pad->idle_ticks = idle_ticks + 1;
}

void PadInitPad(void)
{
    PadInit(0);
    PadResetVibration();
    /* Restarting pad polling does not move the connected controllers between ports. */
    memset(PadJpad, 0, sizeof(PadJpad));
    for (s32 i = 0; i < 8; ++i)
        clear_pad(&PadJpad[i]);
}

void PadStopPad(void)
{
    PadResetVibration();
}

/* Use the same standard-device mapping as PsyZ, with stable slots for four players. */
static void read_gamepad(s32 port, char* packet)
{
    static const struct {
        SDL_GamepadButton button;
        u16 mask;
    } buttons[] = {
        { SDL_GAMEPAD_BUTTON_NORTH, PADRup },
        { SDL_GAMEPAD_BUTTON_SOUTH, PADRdown },
        { SDL_GAMEPAD_BUTTON_WEST, PADRleft },
        { SDL_GAMEPAD_BUTTON_EAST, PADRright },
        { SDL_GAMEPAD_BUTTON_DPAD_UP, PADLup },
        { SDL_GAMEPAD_BUTTON_DPAD_DOWN, PADLdown },
        { SDL_GAMEPAD_BUTTON_DPAD_LEFT, PADLleft },
        { SDL_GAMEPAD_BUTTON_DPAD_RIGHT, PADLright },
        { SDL_GAMEPAD_BUTTON_LEFT_SHOULDER, PADL1 },
        { SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER, PADR1 },
        { SDL_GAMEPAD_BUTTON_LEFT_STICK, PADi },
        { SDL_GAMEPAD_BUTTON_RIGHT_STICK, PADj },
        { SDL_GAMEPAD_BUTTON_START, PADstart },
        { SDL_GAMEPAD_BUTTON_BACK, PADselect },
    };
    static const SDL_GamepadAxis axes[] = {
        SDL_GAMEPAD_AXIS_RIGHTX,
        SDL_GAMEPAD_AXIS_RIGHTY,
        SDL_GAMEPAD_AXIS_LEFTX,
        SDL_GAMEPAD_AXIS_LEFTY,
    };
    SDL_Gamepad* gamepad = SDL_GetGamepadFromID(player_devices[port]);
    memset(packet, 255, PSYZ_PAD_BUF_LEN);
    if (!gamepad)
        return;
    u16 pressed = 0;
    for (s32 i = 0; i < sizeof(buttons) / sizeof(buttons[0]); ++i) {
        if (SDL_GetGamepadButton(gamepad, buttons[i].button))
            pressed |= buttons[i].mask;
    }
    if (SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_LEFT_TRIGGER) > 8000)
        pressed |= PADL2;
    if (SDL_GetGamepadAxis(gamepad, SDL_GAMEPAD_AXIS_RIGHT_TRIGGER) > 8000)
        pressed |= PADR2;
    packet[0] = 0;
    packet[1] = PSYZ_CTRL_ANALOG_PAD;
    for (s32 i = 0; i < 4; ++i)
        packet[4 + i] = (SDL_GetGamepadAxis(gamepad, axes[i]) + 32768) >> 8;
#ifdef TM4_WEB_CONTROLS
    pressed = map_gamepad_buttons(port, pressed, packet + 4);
#endif
    packet[2] = ~(pressed >> 8);
    packet[3] = ~pressed;
}

static u16 read_keyboard(void)
{
#ifdef TM4_WEB_CONTROLS
    if (input_blocked)
        return 0;
    if (browser_keyboard)
        return keyboard_buttons;
#endif
    /* PsyZ's keyboard layout in PS1 button-bit order. */
    static const SDL_Scancode keys[] = {
        SDL_SCANCODE_W,
        SDL_SCANCODE_E,
        SDL_SCANCODE_Q,
        SDL_SCANCODE_R,
        SDL_SCANCODE_S,
        SDL_SCANCODE_D,
        SDL_SCANCODE_X,
        SDL_SCANCODE_Z,
        SDL_SCANCODE_BACKSPACE,
        SDL_SCANCODE_1,
        SDL_SCANCODE_2,
        SDL_SCANCODE_RETURN,
        SDL_SCANCODE_UP,
        SDL_SCANCODE_RIGHT,
        SDL_SCANCODE_DOWN,
        SDL_SCANCODE_LEFT,
    };
    const bool* state = SDL_GetKeyboardState(NULL);
    u16 pressed = 0;
    for (s32 i = 0; i < 16; ++i) {
        if (state[keys[i]])
            pressed |= 1u << i;
    }
    return pressed;
}

static void assign_devices(const SDL_JoystickID* devices, int count)
{
    for (s32 slot = 0; slot < 4; ++slot) {
        s32 i = 0;
        while (i < count && devices[i] != player_devices[slot])
            ++i;
        if (i == count) {
            player_devices[slot] = 0;
#ifdef TM4_WEB_CONTROLS
            raw_buttons[slot] = 0;
            held_buttons[slot] = 0;
            held_sticks[slot] = false;
#endif
        }
    }
    for (s32 i = 0; i < count; ++i) {
        s32 slot = 0;
        while (slot < 4 && player_devices[slot] != devices[i])
            ++slot;
        if (slot != 4)
            continue;
        for (slot = 0; slot < 4; ++slot) {
            if (!player_devices[slot]) {
                player_devices[slot] = devices[i];
                break;
            }
        }
    }
}

s32 PadGetPad(s32 capacity)
{
    if (capacity <= 0)
        return 0;
    if (capacity > 8)
        capacity = 8;

    /* Let PsyZ pump SDL events before enumerating devices. Its two-port cache
     * compacts on disconnect, so it cannot supply multiplayer identities. */
    char sampled[PSYZ_PAD_BUF_LEN];
    Psyz_PadsGet(0, sampled, sizeof(sampled));
    int gamepad_count = 0;
    SDL_JoystickID* gamepads = SDL_GetGamepads(&gamepad_count);
    assign_devices(gamepads, gamepad_count);
    SDL_free(gamepads);

    s32 count = 0;
    for (s32 port = 0; port < 4 && count < capacity; ++port) {
        char packet[PSYZ_PAD_BUF_LEN];
        if (player_devices[port]) {
            read_gamepad(port, packet);
        } else if (port == 0 && gamepad_count == 0) {
            memset(packet, 0, sizeof(packet));
            packet[1] = PSYZ_CTRL_DIGITAL_PAD;
            packet[2] = packet[3] = 255;
        } else {
            continue;
        }
        u8 type = (u8)packet[1];
        if (packet[0] != 0 || (type != PSYZ_CTRL_DIGITAL_PAD && type != PSYZ_CTRL_ANALOG_PAD))
            continue;

        PadCache* pad = &PadJpad[count++];
        pad->previous_buttons = pad->buttons;
        memcpy(pad->previous_axes, pad->axes, sizeof(pad->axes));
        pad->device_type = type;
        pad->has_analog = type == PSYZ_CTRL_ANALOG_PAD;
        pad->port_id = ((port & 1) << 4) | (port >> 1);
        pad->absent_ticks = 0;
        pad->buttons = ~((u8)packet[2] << 8 | (u8)packet[3]);
        if (port == 0)
            pad->buttons |= read_keyboard();
        /* Preserve PadRead's rejection of opposite keyboard directions. */
        if ((pad->buttons & (PADLleft | PADLright)) == (PADLleft | PADLright))
            pad->buttons &= ~(PADLleft | PADLright);
        if ((pad->buttons & (PADLup | PADLdown)) == (PADLup | PADLdown))
            pad->buttons &= ~(PADLup | PADLdown);
        if (pad->has_analog)
            memcpy(pad->axes, packet + 4, sizeof(pad->axes));
        else
            memset(pad->axes, 0, sizeof(pad->axes));
        pad->pressed_buttons = pad->buttons & ~pad->previous_buttons;
        pad->released_buttons = pad->previous_buttons & ~pad->buttons;
        pad->idle_ticks = pad->buttons ? 0 : pad->idle_ticks + 1;
    }
    WebPadUpdateVibration(player_devices, 4);
    for (s32 i = count; i < capacity; ++i)
        clear_pad(&PadJpad[i]);
    return (u32)PadJpad[0].buttons | ((u32)PadJpad[1].buttons << 16);
}
