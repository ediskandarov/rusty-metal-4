#include "car.h"
#include "interpolation.h"
#include "level.h"
#include "net_match.h"
#include "overlays.h"
#include "port/web/browser_report.h"
#include "port/web/module_import.h"
#include "src/main/object/private.h"
#include "src/modules/car/private.h"
#include "tm4/gpu.h"
#include "tm4/main/game.h"
#include "tm4/main/image.h"
#include "tm4/main/memory.h"
#include "tm4/main/object.h"
#include "tm4/main/os.h"
#include "tm4/main/pad.h"
#include "tm4/main/sound.h"
#include "tm4/main/world.h"
#include "tm4/modules/car_scratch.h"
#include "tm4/modules/interact.h"
#include "tm4/modules/sound.h"
#include "tm4/vector.h"
#include <assert.h>
#include <libetc.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static Car* player;
static unsigned int simulation_ticks;

static s32 construct_car(void* object, va_list args)
{
    return WEB_MODULE("car", CarConstructor)(object, args);
}

static void display_car(void* object, Tm4OrderingTag* ordering, u8** cursor, u8* end, MATRIX* view)
{
    u8* start = *cursor;
    Car pose;
    Car* render_car = WebInterpolationCar(object, &pose);
    WEB_MODULE("car", CarDisplay)(render_car, ordering, cursor, end, view);
    WebInterpolationEndCarDraw();
    WEB_BROWSER_REPORT({ globalThis.tm4Port.carPacketBytes = $0; }, *cursor - start);
}

/* dlclose may keep code/data resident; each new world needs a fresh search epoch. */
void WebCarResetSearchState(void)
{
    WEB_MODULE("car", CarPathSearchGeneration) = 0;
    WEB_MODULE("car", CarRandomSearchGeneration)[0] = 0;
    WEB_MODULE("car", CarHealthSearchGeneration) = 0;
}

void WebCarEnable(void)
{
#ifdef TM4_WEB_TEST_HOOKS
    WEB_BROWSER_REPORT(
        {
            tm4Port.carSearchGenerationsAtLoad = tm4Port.carSearchGenerationsAtLoad || [];
            tm4Port.carSearchGenerationsAtLoad.push([ $0, $1, $2 ]);
        },
        WEB_MODULE("car", CarPathSearchGeneration), WEB_MODULE("car", CarRandomSearchGeneration)[0],
        WEB_MODULE("car", CarHealthSearchGeneration));
#endif
    WEB_MODULE("car", OSRegisterSoundEmitter)();
    WEB_MODULE("car", OSRegisterAnimInfo)();
    WEB_MODULE("car", OSRegisterExplosion)();
    WEB_MODULE("car", OSRegisterAiSoundEmitter)();
    WEB_MODULE("car", OSRegisterAiPowerup)();
    WEB_MODULE("car", OSRegisterWeaponSoundEmitter)();
    WEB_MODULE("car", OSRegisterWeaponAnimInfo)();
    WEB_MODULE("car", OSRegisterWeaponExplosion)();
    WEB_MODULE("car", OSRegisterWeaponBullet)();
    WEB_MODULE("car", OSRegisterPhysicsSoundEmitter)();
    WEB_MODULE("car", OSRegisterPhysicsAnimInfo)();
    WEB_MODULE("car", OSRegisterPhysicsExplosion)();
    WEB_MODULE("car", OSRegisterDisplaySoundEmitter)();
    WEB_MODULE("car", OSRegisterCameraSoundEmitter)();
    WEB_MODULE("car", OSRegisterWorldSoundEmitter)();
    WEB_MODULE("car", OSRegisterWorldPowerup)();
}

void CarClassDestructor(RegistryDirectory*);
extern u32 CarSizeof;

OSWord WebCarObjectExport(const char* name)
{
    if (!WebNativeModuleLoaded("o_car.sym"))
        return 0;
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("CarSizeof", &WEB_MODULE("car", CarSizeof));
    EXPORT("CarClassConstructor", WEB_MODULE("car", CarClassConstructor));
    EXPORT("CarClassDestructor", WEB_MODULE("car", CarClassDestructor));
    EXPORT("CarConstructor", construct_car);
    EXPORT("CarProcess", WEB_MODULE("car", CarProcess));
    EXPORT("CarDisplay", display_car);
    EXPORT("CarDestructor", WEB_MODULE("car", CarDestructor));
    EXPORT("InteractCarWithCar", WEB_MODULE("car", InteractCarWithCar));
    EXPORT("InteractCarWithBullet", WEB_MODULE("interact", InteractCarWithBullet));
#undef EXPORT
    return 0;
}

void WebCarStart(void)
{
    GameSpawnModeCars();
    player = GameInfo.players[WebNetMatchActive() ? WebNetParticipantSlot(0) : 0].car;
    assert(player);
    printf("Match cars: %d (%d opponents), player %s\n", GameInfo.car_count,
        GameInfo.active_computer_count, player->character_name);
    WEB_BROWSER_REPORT({ tm4Port.car = UTF8ToString($0); }, player->character_name);
}

void WebCarStep(void)
{
    ObjectProcess();
    player = GameInfo.players[WebNetMatchActive() ? WebNetParticipantSlot(0) : 0].car;
    simulation_ticks++;
    WEB_BROWSER_REPORT(
        { tm4Port.controlBindings = Array.from(HEAPU16.subarray($0 >> 1, ($0 >> 1) + $1)); },
        GameInfo.players[WebNetMatchActive() ? WebNetParticipantSlot(0) : 0].bindings[0].actions,
        GameControlCount);
    WEB_BROWSER_REPORT(
        {
            tm4Port.cars = [];
            tm4Port.opponents = $0;
            tm4Port.aiEnabled = $1;
        },
        GameInfo.active_computer_count, WEB_MODULE("car", aiWorldInfo).enabled);
    for (s32 i = 0; i < GameInfo.car_count; ++i) {
        Car* other = GameInfo.cars[i];
        WEB_BROWSER_REPORT(
            {
                tm4Port.cars.push({
                    name : UTF8ToString($0),
                    x : $1,
                    y : $2,
                    z : $3,
                    health : $4,
                    control : $5,
                    throttle : $6,
                    ai : $7,
                    player : $8,
                    steering : $9
                });
            },
            other->character_name, other->transform.t[0], other->transform.t[1],
            other->transform.t[2], other->health, other->control_kind,
            other->controls.throttle_input, other->ai_input_callback != NULL,
            other->controller_index, other->controls.steering_input);
    }
    Car* car = player;
    WEB_BROWSER_REPORT({ tm4Port.carAlive = $0; }, car != NULL);
    if (!car)
        return;
    WEB_BROWSER_REPORT(
        {
            Object.assign(globalThis.tm4Port, {
                carX : $0,
                carY : $1,
                carZ : $2,
                carTicks : $3,
                carContact : $4,
                carThrottle : $5,
                carSteering : $6,
                enginePitch : $7,
                engineVoice : $8,
                engineSound : UTF8ToString($9),
                carGear : $10,
                carBrake : $11,
                carEbrake : $12,
                carGasBinding : $13
            });
        },
        car->transform.t[0], car->transform.t[1], car->transform.t[2], simulation_ticks,
        car->particles[0].contact_state | car->particles[1].contact_state
            | car->particles[2].contact_state | car->particles[3].contact_state,
        car->controls.throttle_input, car->controls.steering_input,
        car->engine_sound ? car->engine_sound->voices[0].pitch : 0,
        car->engine_sound ? car->engine_sound->voices[0].voice_id : -1, car->engine_sound_name,
        car->controls.gear, car->controls.brake_input, car->controls.ebrake_active,
        GameInfo.players[WebNetMatchActive() ? WebNetParticipantSlot(0) : 0]
            .bindings[0]
            .actions[GameControlGas]);
    CarWeaponInstance* selected = &car->weapons[car->controls.selected_weapon];
    WEB_BROWSER_REPORT(
        {
            tm4Port.weaponName = UTF8ToString($0);
            tm4Port.weaponAmmo = $1;
        },
        selected->descriptor->name, selected->amount);
    WEB_BROWSER_REPORT(
        {
            Object.assign(globalThis.tm4Port, {
                carHealth : $0,
                carWeaponSlots : $1,
                carSelectedWeapon : $2,
                cameraAttached : $3
            });
        },
        car->health, car->weapons ? 20 : 0, car->controls.selected_weapon,
        GameInfo.players[WebNetMatchActive() ? WebNetParticipantSlot(0) : 0].camera->object == car
            && GameInfo.players[WebNetMatchActive() ? WebNetParticipantSlot(0) : 0].camera->process
                != NULL);
}
