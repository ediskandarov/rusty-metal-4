#ifndef TM4_WEB_INTERPOLATION_H
#define TM4_WEB_INTERPOLATION_H

#include <LIBGTE.H>
#include "tm4_scalar.h"

typedef struct Afc Afc;
typedef struct Bullet Bullet;
typedef struct Camera Camera;
typedef struct Car Car;
typedef struct ExplosionWave ExplosionWave;
typedef struct Lightning Lightning;
typedef struct PowerupState PowerupState;
typedef struct RayBeam RayBeam;
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
void WebInterpolationBullet(const Bullet* bullet, SVECTOR* head, SVECTOR* tail);
int WebInterpolationTrailTip(const WeaponProjectile* projectile, SVECTOR tip[4]);
void WebInterpolationFireball(const WeaponFireball* fireball, SVECTOR* position);
MATRIX* WebInterpolationSceneModel(const void* object, MATRIX* live, MATRIX* sample);
s32 WebInterpolationAngle(s32 previous, s32 current);
void WebInterpolationSceneRotors(const void* object, s32* top, s32* tail);
s32 WebInterpolationCraneGround(const void* crane, s32 current);
s32 WebInterpolationCarAccessory(const Car* car, s32 slot, s32 angle);
MATRIX* WebInterpolationCarTransform(const Car* car, MATRIX* sample);
MATRIX* WebInterpolationRay(const RayBeam* ray, MATRIX* live, MATRIX* sample, s32* length);
int WebInterpolationLightning(const Lightning* bolt, MATRIX* transform, SVECTOR* points);
void WebInterpolationCarPoint(const Car* car, const SVECTOR* point, SVECTOR* sample);
void WebInterpolationObjectPosition(const void* object, SVECTOR* position);
void WebInterpolationAfc(const Afc* object, s32* angle, s16* size);
s32 WebInterpolationPortalSize(const void* portal, s32 size);
void WebInterpolationAnimSize(const void* animation, s32 part, s32* width, s32* height);
void WebInterpolationWave(const ExplosionWave* wave, s32* outer, s32* inner, s32* height);
void WebInterpolationEndCarDraw(void);
const Car* WebInterpolationCarIdentity(const Car* car);

#endif
