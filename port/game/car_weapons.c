#include "src/modules/car/private.h"
#include "tm4_scalar.h"

#include "tm4/fixed.h"
#include "tm4/main/easteregg.h"
#include "tm4/main/memory.h"
#include "tm4/main/os.h"
#include "tm4/main/screen.h"
#include "tm4/main/system.h"

#include <STDIO.H>
#include <STRINGS.H>

void* CarWeaponGetFileData(char* name, char* directory)
{
    char path[strlen(directory) + strlen(name) + 2];
    void* result = RegGetFileDataS(name);
    if (!result) {
        sprintf(path, CarResourcePathFormatWeapon, directory, name);
        result = RegGetFileDataPS(CarClassDirectory, path);
    }
    return result;
}

CarWeaponInstance* CarGetWeaponToFire(Car* car, s32* flag)
{
    CarWeaponInstance* result = NULL;
    CarAction action = car->controls.action;
    if (action == CarActionRearAttack) {
        s32 index = car->controls.selected_weapon;
        CarWeaponInstance* weapons = car->weapons;
        *flag = 1;
        result = &weapons[index];
    } else if (action == CarActionFreezeAttack) {
        result = CarWeaponForRole(car, CarWeaponFreeze);
    } else if (action == CarActionRearFreezeAttack) {
        *flag = 1;
        result = CarWeaponForRole(car, CarWeaponFreeze);
    } else if (action == CarActionMassiveAttack) {
        result = CarWeaponForRole(car, CarWeaponMassive);
    } else if (action == CarActionRearMassiveAttack) {
        *flag = 1;
        result = CarWeaponForRole(car, CarWeaponMassive);
    }
    return result;
}

s32 CarWeaponConstructor(Car* car, s32 type)
{
    s32 i;
    s16 selected;
    RegistryDirectory *saved, *directory;
    char* launch_name;
    s16* regen;
    const s32 weapon_count = CarWeaponCount;
    RegistryDirectory* ai_weights = RegGetDirectoryPtrS("ai/weaponWeights");
    car->controls.weapon_held = 0;
    car->controls.weapon_pressed = 0;
    car->controls.selected_weapon_slot = 0;
    selected = 0;
    car->special_regeneration_ticks = 0;
    car->special_regeneration_interval = 300;
    car->controls.selected_weapon = selected;
    car->weapons = MemCalloc(weapon_count, sizeof(*car->weapons));
    if (!car->weapons)
        return 0;
    for (i = 0; i < weapon_count; i++) {
        if (CarWeaponDescriptors[i].role == CarWeaponSpecial) {
            char symbol[strlen(car->filename) + sizeof(CAR_SPECIAL_CONSTRUCTOR_FORMAT)];
            car->weapons[i].descriptor = MemAlloc(sizeof(*car->weapons[i].descriptor));
            if (!car->weapons[i].descriptor) {
                return 0;
            } else {
                *car->weapons[i].descriptor = CarWeaponDescriptors[i];
                saved = RegGetCurrentDirectoryPtr();
                RegChangeCurrentDirectoryS(CarTextSpecial);
                car->weapons[i].descriptor->name
                    = CarWeaponGetFileData(CarTextName, CarTextWeaponDefault);
                car->weapons[i].descriptor->hud_name = RegGetFileDataS(CarTextHudName);
                if (!car->weapons[i].descriptor->hud_name)
                    car->weapons[i].descriptor->hud_name = car->weapons[i].descriptor->name;
                car->weapons[i].descriptor->initial
                    = *(s16*)CarWeaponGetFileData(CarTextInitial, CarTextWeaponDefault);
                car->weapons[i].descriptor->maximum
                    = *(s16*)CarWeaponGetFileData(CarTextMax, CarTextWeaponDefault);
                car->weapons[i].descriptor->delay = Q12MulRound(
                    *(s32*)CarWeaponGetFileData(CarTextDelay, CarTextWeaponDefault), 30);
                car->weapons[i].descriptor->detonate
                    = *(u8*)CarWeaponGetFileData(CarTextDetonate, CarTextWeaponDefault);
                car->weapons[i].descriptor->repeat
                    = *(u8*)CarWeaponGetFileData(CarTextRepeat, CarTextWeaponDefault);
                launch_name = RegGetFileDataS(CarTextLaunchFunc);
                if (!launch_name || !strlen(launch_name)) {
                    sprintf(symbol, CarSpecialConstructorFormat, car->filename);
                    launch_name = symbol;
                }
                car->weapons[i].descriptor->launch
                    = (CarWeaponLaunch)OSSymbolGetAddress(launch_name);
                if (!car->weapons[i].descriptor->launch)
                    car->weapons[i].descriptor->launch = CarLaunchSpecial;
                regen = RegGetFileDataS(CarTextRegen);
                if (regen)
                    car->special_regeneration_interval = *regen * SIMULATION_FPS;
                if (EasterEggAccessible(5))
                    car->special_regeneration_interval = 120;
                RegChangeCurrentDirectoryP(saved);
            }
        } else {
            car->weapons[i].descriptor = &CarWeaponDescriptors[i];
        }
        car->weapons[i].ai_weights
            = CarWeaponReadAiWeights(ai_weights, CarWeaponDescriptors[i].ai_category->id);
        car->weapons[i].profile_key = car->weapons[i].descriptor->profile_key;
        const CarWeaponRole role = car->weapons[i].descriptor->role;
        if (type == 1) {
            car->weapons[i].amount = car->weapons[i].descriptor->initial;
            if ((EasterEggAccessible(3) && role == CarWeaponMassive)
                || (EasterEggAccessible(2) && role == CarWeaponFreeze))
                car->weapons[i].amount = 99;
            if (EasterEggAccessible(1) && role != CarWeaponMassive && role != CarWeaponFreeze)
                car->weapons[i].amount = 99;
        } else
            car->weapons[i].amount = -1;
        car->weapons[i].next_time = 0;
        car->weapons[i].active = 0;
        car->weapons[i].index = 0;
        if (!car->weapons[i].descriptor->name) {
            car->weapons[i].launchers = &CarDefaultLaunchMount;
            car->weapons[i].count = 1;
        } else {
            if ((car->weapons[i].launchers = RegGetFileDataS(car->weapons[i].descriptor->name))) {
                car->weapons[i].count = RegGetFileArraySizeS(car->weapons[i].descriptor->name);
            } else {
                directory = car->weapons[i].descriptor->resource;
                if (!directory) {
                    car->weapons[i].launchers = &CarDefaultLaunchMount;
                    car->weapons[i].count = 1;
                } else {
                    car->weapons[i].launchers = RegGetFileDataPS(directory, CarTextLauncher);
                    if (!car->weapons[i].launchers) {
                        car->weapons[i].launchers = &CarDefaultLaunchMount;
                        car->weapons[i].count = 1;
                    } else
                        car->weapons[i].count = RegGetFileArraySizePS(directory, CarTextLauncher);
                }
            }
        }
    }
    return 1;
}

void CarWeaponDestructor(Car* car)
{
    s32 i;
    const s32 weapon_count = CarWeaponCount;
    if (!car->weapons)
        return;
    for (i = 0; i < weapon_count; i++) {
        if (car->weapons[i].descriptor && car->weapons[i].descriptor->detonate
            && car->weapons[i].active)
            CarDetonateWeaponDevices(&car->weapons[i]);
    }
    for (i = 0; i < weapon_count; ++i)
        if (car->weapons[i].descriptor && car->weapons[i].descriptor->role == CarWeaponSpecial)
            MemFree(car->weapons[i].descriptor);
    MemFree(car->weapons);
    car->weapons = NULL;
}

void CarWeaponProcess(Car* car)
{
    CarWeaponInstance* special;
    s32 flag = 0, pending;
    u32 now;
    CarWeaponInstance *selected = &car->weapons[car->controls.selected_weapon], *override;
    if (!(selected->descriptor->detonate && selected->active) && !selected->amount)
        CarSelectNextUsableWeapon(car, 1);
    selected = &car->weapons[car->controls.selected_weapon];
    override = CarGetWeaponToFire(car, &flag);
    if (override)
        selected = override;
    pending = selected->descriptor->detonate && selected->active != 0;
    now = GetCurrentTime();
    if (selected->next_time < now
        && (car->controls.weapon_pressed || override
            || (car->controls.weapon_held && selected->descriptor->repeat))
        && selected->descriptor->launch && !car->freeze_ticks) {
        if (car->control_kind == CAR_CONTROL_PLAYER && !selected->amount && !pending && !override) {
            ScreenLocalMessageRegister(car->controller_index, CarEmptyInventoryMessage);
        } else {
            selected->next_time = now + selected->descriptor->delay;
            if (pending)
                CarDetonateWeaponDevices(selected);
            else if (selected->descriptor->launch(car, car->callback_context, selected, flag) == 1)
                CarDecrementAmmo(&selected->amount);
        }
        car->controls.weapon_pressed = 0;
    }
    special = CarWeaponForRole(car, CarWeaponSpecial);
    if (!special)
        return;
    if (special->amount >= special->descriptor->maximum)
        return;
    if (car->special_regeneration_ticks < car->special_regeneration_interval)
        car->special_regeneration_ticks++;
    else {
        special->amount++;
        car->special_regeneration_ticks = 0;
    }
}
