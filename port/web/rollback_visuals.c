#include "rollback_visuals.h"
#include "tm4/main/game.h"
#include "tm4/main/object.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/car.h"
#include <limits.h>
#include <math.h>
#include <string.h>

/* Presentation offsets never enter checkpoints or canonical simulation state. */
typedef struct {
    const void* object;
    u32 serial, target;
    MATRIX before;
    double offset[3], before_offset[3];
    double started;
    int pending;
} Correction;

static Correction cars[ArrayCount(GameInfo.cars)];
static Correction cameras[ArrayCount(GameInfo.players)];
static const double duration_ms = 100;
static const double maximum_distance = 256;

static u32 identity(const void* object)
{
    return object ? (u32)ObjectGetHeader(object)->serial + 1u : 0;
}

static double weight(const Correction* correction, double now)
{
    return fmax(0, fmin(1, 1 - (now - correction->started) / duration_ms));
}

void WebRollbackVisualsReset(void)
{
    memset(cars, 0, sizeof(cars));
    memset(cameras, 0, sizeof(cameras));
}

static void remember(
    Correction* correction, const void* object, u32 target, const MATRIX* transform, double now)
{
    if (correction->object != object || correction->serial != identity(object)
        || correction->target != target)
        memset(correction, 0, sizeof(*correction));
    double remaining = weight(correction, now);
    correction->object = object;
    correction->serial = identity(object);
    correction->target = target;
    correction->before = *transform;
    for (int axis = 0; axis < 3; ++axis)
        correction->before_offset[axis] = correction->offset[axis] * remaining;
    correction->pending = 1;
}

void WebRollbackVisualsRemember(double now)
{
    for (int i = 0; i < GameInfo.car_count; ++i) {
        const Car* car = GameInfo.cars[i];
        if (car)
            remember(&cars[i], car, 0, &car->transform, now);
    }
    for (int i = 0; i < GameInfo.player_count; ++i) {
        const Camera* camera = GameInfo.players[i].camera;
        if (camera)
            remember(&cameras[i], camera, identity(camera->object), &camera->camera_to_world, now);
    }
}

static void reconcile(
    Correction* correction, const void* object, u32 target, const MATRIX* transform, double now)
{
    if (!correction->pending || correction->object != object
        || correction->serial != identity(object) || correction->target != target) {
        memset(correction, 0, sizeof(*correction));
        return;
    }
    correction->pending = 0;
    if (memcmp(correction->before.t, transform->t, sizeof(transform->t)) == 0)
        return;
    for (int axis = 0; axis < 3; ++axis) {
        correction->offset[axis] = correction->before_offset[axis]
            + (double)correction->before.t[axis] - transform->t[axis];
        if (fabs(correction->offset[axis]) > maximum_distance) {
            memset(correction, 0, sizeof(*correction));
            return;
        }
    }
    correction->started = now;
}

void WebRollbackVisualsReconcile(double now)
{
    for (int i = 0; i < ArrayCount(cars); ++i) {
        const Car* car = i < GameInfo.car_count ? GameInfo.cars[i] : NULL;
        if (car)
            reconcile(&cars[i], car, 0, &car->transform, now);
        else
            memset(&cars[i], 0, sizeof(cars[i]));
    }
    for (int i = 0; i < ArrayCount(cameras); ++i) {
        const Camera* camera = i < GameInfo.player_count ? GameInfo.players[i].camera : NULL;
        if (camera)
            reconcile(&cameras[i], camera, identity(camera->object), &camera->camera_to_world, now);
        else
            memset(&cameras[i], 0, sizeof(cameras[i]));
    }
}

void WebRollbackVisualsCut(const void* object)
{
    for (int i = 0; i < ArrayCount(cars); ++i) {
        if (cars[i].object == object)
            memset(&cars[i], 0, sizeof(cars[i]));
    }
    for (int i = 0; i < ArrayCount(cameras); ++i) {
        if (cameras[i].object == object || cameras[i].target == identity(object))
            memset(&cameras[i], 0, sizeof(cameras[i]));
    }
}

static int sample(const Correction* corrections, int count, const void* object, u32 target,
    MATRIX* draw, double now)
{
    for (int i = 0; i < count; ++i) {
        const Correction* correction = &corrections[i];
        if (correction->object != object || correction->serial != identity(object)
            || correction->target != target)
            continue;
        double remaining = weight(correction, now);
        int changed = 0;
        s32 offsets[3];
        for (int axis = 0; axis < 3; ++axis) {
            offsets[axis] = lround(correction->offset[axis] * remaining);
            double value = (double)draw->t[axis] + offsets[axis];
            if (value < INT_MIN || value > INT_MAX)
                return 0;
            changed |= offsets[axis] != 0;
        }
        for (int axis = 0; axis < 3; ++axis)
            draw->t[axis] += offsets[axis];
        return changed;
    }
    return 0;
}

int WebRollbackVisualsCar(const Car* car, MATRIX* draw, double now)
{
    return sample(cars, ArrayCount(cars), car, 0, draw, now);
}

int WebRollbackVisualsCamera(const Camera* camera, MATRIX* draw, double now)
{
    return sample(cameras, ArrayCount(cameras), camera, identity(camera->object), draw, now);
}
