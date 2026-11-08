#ifndef TM4_WEB_PAD_VIBRATION_H
#define TM4_WEB_PAD_VIBRATION_H

#include <SDL3/SDL_gamepad.h>

void WebPadUpdateVibration(const SDL_JoystickID* devices, int count);

#endif
