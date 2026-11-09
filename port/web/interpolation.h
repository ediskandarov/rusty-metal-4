#ifndef TM4_WEB_INTERPOLATION_H
#define TM4_WEB_INTERPOLATION_H

#include <LIBGTE.H>
#include "tm4_scalar.h"

typedef struct Camera Camera;
typedef struct Car Car;
typedef struct PowerupState PowerupState;
typedef struct WeaponFireball WeaponFireball;
typedef struct WeaponProjectile WeaponProjectile;

void WebInterpolationReset(void);
void WebInterpolationBeginStep(void);
void WebInterpolationFinishStep(void);
void WebInterpolationCutCamera(const Camera* camera);
void WebInterpolationCutCar(const Car* car);
void WebInterpolationBeginDraw(double fraction, int stepped);
void WebInterpolationEndDraw(void);
int WebInterpolationEnabled(void);
int WebInterpolationAdvanceDisplay(void);
Camera* WebInterpolationCamera(Camera* camera, Camera* pose);
Car* WebInterpolationCar(Car* car, Car* pose);
void WebInterpolationPickup(const PowerupState* power, SVECTOR* position, s32* angle);
void WebInterpolationProjectile(const WeaponProjectile* projectile, MATRIX* model,
    SVECTOR* shadow, s32 spin_step, s32* angle);
void WebInterpolationFireball(const WeaponFireball* fireball, SVECTOR* position);
void WebInterpolationEndCarDraw(void);
const Car* WebInterpolationCarIdentity(const Car* car);

#endif
