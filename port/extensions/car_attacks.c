#include "car_attacks.h"
#include "car_profile.h"
#include "tm4/main/os.h"
#include "tm4/modules/car.h"
#include "tm4/modules/car_weapon.h"
#include <stdio.h>

int WebCarAttacksLoad(Car* car)
{
    Rm4CarProfileReader attack = WebCarProfileOpen("freezeAttack");
    car->freeze_launch = NULL;
    if (attack.valid && attack.resource) {
        char* name = WebCarProfileString(&attack, "launchFunc", 1);
        car->freeze_launch = name ? (CarWeaponLaunch)OSSymbolGetAddress(name) : NULL;
        if (!car->freeze_launch) {
            fprintf(stderr, "Invalid freezeAttack launcher: %s\n", name ? name : "(missing)");
            return 0;
        }
    }
    return attack.valid;
}
