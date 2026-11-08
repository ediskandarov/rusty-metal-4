#include <LIBGTE.H>
#include "interpolation.h"
#include "tm4/fixed.h"
#include "tm4/main/game.h"
#include "tm4/main/math3d.h"
#include "tm4/main/object.h"
#include "tm4/main/system.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/car.h"
#include <emscripten.h>
#include <math.h>
#include <string.h>

typedef struct {
    u32 serial;
    MATRIX transform;
    struct {
        s16 rotation, steering;
        s8 suspension;
    } wheels[4];
} CarPose;

typedef struct {
    u32 serial;
    u32 target_serial;
    MATRIX transform;
} CameraPose;

static CarPose cars[ArrayCount(GameInfo.cars)];
static CameraPose cameras[ArrayCount(GameInfo.players)];
static int enabled, completed, drawing, advance_display;
static double fraction;
static u32 effect_seed, restore_effect_seed;
static int have_effect_seed;
static const Car* car_identity;
static const Car* car_pose;

u32 WebRenderEffectRandomState(void);

EMSCRIPTEN_KEEPALIVE void WebSetRenderInterpolation(int on)
{
    enabled = !!on;
}

int WebInterpolationEnabled(void)
{
    return enabled;
}

static u32 serial(const void* object)
{
    return object ? (u32)ObjectGetHeader(object)->serial + 1u : 0;
}

void WebInterpolationReset(void)
{
    have_effect_seed = 0;
    completed = 0;
    memset(cars, 0, sizeof(cars));
    memset(cameras, 0, sizeof(cameras));
}

void WebInterpolationBeginStep(void)
{
    /* Live simulation state is the newer endpoint after this tick completes. */
    completed = 0;
    memset(cars, 0, sizeof(cars));
    memset(cameras, 0, sizeof(cameras));
    for (s32 i = 0; i < GameInfo.car_count; ++i) {
        const Car* car = GameInfo.cars[i];
        CarPose* pose = &cars[i];
        pose->serial = serial(car);
        pose->transform = car->transform;
        for (s32 wheel = 0; wheel < ArrayCount(car->wheels); ++wheel) {
            pose->wheels[wheel].rotation = car->wheels[wheel].rotation;
            pose->wheels[wheel].steering = car->wheels[wheel].steering;
            pose->wheels[wheel].suspension = car->wheels[wheel].direction.fields.displacement;
        }
    }
    for (s32 i = 0; i < GameInfo.player_count; ++i) {
        const Camera* camera = GameInfo.players[i].camera;
        cameras[i].serial = serial(camera);
        cameras[i].target_serial = serial(camera->object);
        cameras[i].transform = camera->camera_to_world;
    }
}

void WebInterpolationFinishStep(void)
{
    completed = 1;
}

void WebInterpolationCutCamera(const Camera* camera)
{
    for (s32 i = 0; i < ArrayCount(cameras); ++i) {
        if (cameras[i].serial == serial(camera))
            cameras[i].serial = 0;
    }
}

void WebInterpolationCutCar(const Car* car)
{
    u32 id = serial(car);
    for (s32 i = 0; i < ArrayCount(cars); ++i) {
        if (cars[i].serial == id)
            cars[i].serial = 0;
    }
    for (s32 i = 0; i < ArrayCount(cameras); ++i) {
        if (cameras[i].target_serial == id)
            cameras[i].serial = 0;
    }
}

void WebInterpolationBeginDraw(double sample, int stepped)
{
    fraction = fmin(1, fmax(0, sample));
    advance_display = stepped;
    /* Replay the last display tick's visual noise without advancing its RNG. */
    restore_effect_seed = WebRenderEffectRandomState();
    if (stepped || !have_effect_seed)
        effect_seed = restore_effect_seed;
    if (!stepped)
        srandrand(effect_seed);
    have_effect_seed = 1;
    drawing = 1;
}

void WebInterpolationEndDraw(void)
{
    if (drawing && !advance_display)
        srandrand(restore_effect_seed);
    drawing = 0;
}

int WebInterpolationAdvanceDisplay(void)
{
    return !drawing || advance_display;
}

static s32 lerp(s32 a, s32 b)
{
    return lround(a + fraction * ((double)b - a));
}

static s16 lerp_angle(s16 a, s16 b)
{
    const s32 angle_mask = ANGLE_FULL_TURN - 1;
    s32 delta = ((b - a + ANGLE_HALF_TURN) & angle_mask) - ANGLE_HALF_TURN;
    return (a + lround(fraction * delta)) & angle_mask;
}

static int normalize(double v[3])
{
    double length = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (length < 128)
        return 0;
    for (int i = 0; i < 3; ++i)
        v[i] /= length;
    return 1;
}

static int interpolate_matrix(const MATRIX* before, const MATRIX* after, MATRIX* result)
{
    double right[3], up[3];
    for (int i = 0; i < 3; ++i) {
        /* Guard discontinuities that bypass the explicit car and camera cut hooks. */
        if (fabs((double)after->t[i] - before->t[i]) > 1024)
            return 0;
        right[i] = lerp(before->m[i][0], after->m[i][0]);
        up[i] = lerp(before->m[i][1], after->m[i][1]);
    }
    /* Normalize the blended basis before computing the camera inverse. */
    if (!normalize(right))
        return 0;
    double dot = right[0] * up[0] + right[1] * up[1] + right[2] * up[2];
    for (int i = 0; i < 3; ++i)
        up[i] -= dot * right[i];
    if (!normalize(up))
        return 0;
    for (int i = 0; i < 3; ++i) {
        int j = (i + 1) % 3, k = (i + 2) % 3;
        result->m[i][0] = lround(ONE * right[i]);
        result->m[i][1] = lround(ONE * up[i]);
        result->m[i][2] = lround(ONE * (right[j] * up[k] - right[k] * up[j]));
        result->t[i] = lerp(before->t[i], after->t[i]);
    }
    return 1;
}

Camera* WebInterpolationCamera(Camera* camera, Camera* pose)
{
    if (!drawing || !completed || fraction >= 1)
        return camera;
    u32 id = serial(camera);
    for (s32 i = 0; i < ArrayCount(cameras); ++i) {
        const CameraPose* previous = &cameras[i];
        if (previous->serial != id || previous->target_serial != serial(camera->object))
            continue;
        *pose = *camera;
        if (!interpolate_matrix(
                &previous->transform, &camera->camera_to_world, &pose->camera_to_world))
            break;
        InverseMatrix(&pose->camera_to_world, &pose->world_to_camera);
        return pose;
    }
    return camera;
}

Car* WebInterpolationCar(Car* car, Car* pose)
{
    if (!drawing || !completed || fraction >= 1)
        return car;
    u32 id = serial(car);
    for (s32 i = 0; i < ArrayCount(cars); ++i) {
        const CarPose* previous = &cars[i];
        if (previous->serial != id)
            continue;
        *pose = *car;
        if (!interpolate_matrix(&previous->transform, &car->transform, &pose->transform))
            break;
        for (s32 wheel = 0; wheel < ArrayCount(car->wheels); ++wheel) {
            pose->wheels[wheel].rotation
                = lerp_angle(previous->wheels[wheel].rotation, car->wheels[wheel].rotation);
            pose->wheels[wheel].steering
                = lerp(previous->wheels[wheel].steering, car->wheels[wheel].steering);
            pose->wheels[wheel].direction.fields.displacement
                = lerp(previous->wheels[wheel].suspension,
                    car->wheels[wheel].direction.fields.displacement);
        }
        car_identity = car;
        car_pose = pose;
        return pose;
    }
    return car;
}

void WebInterpolationEndCarDraw(void)
{
    car_identity = car_pose = NULL;
}

const Car* WebInterpolationCarIdentity(const Car* car)
{
    return car == car_pose ? car_identity : car;
}
