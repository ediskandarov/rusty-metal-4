#include <LIBGTE.H>
#include "interpolation.h"
#include "src/modules/weap/private.h"
#include "tm4/fixed.h"
#include "tm4/main/game.h"
#include "tm4/main/math3d.h"
#include "tm4/main/object.h"
#include "tm4/main/system.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/car.h"
#include <emscripten.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

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

typedef struct {
    uintptr_t address;
    s32 serial;
    union {
        struct {
            SVECTOR position;
            s16 angle;
        } pickup;
        struct {
            MATRIX transform;
            SVECTOR shadow;
            u32 age;
        } projectile;
        SVECTOR fireball;
    };
} ObjectPose;

static ObjectPose* objects;
static size_t object_count, object_capacity;
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
    object_count = 0;
    memset(cars, 0, sizeof(cars));
    memset(cameras, 0, sizeof(cameras));
}

static SVECTOR fireball_position(const WeaponFireball* fireball)
{
    const SVECTOR* previous = &fireball->previous;
    const Tm4ShortVectorXYZ* current = &fireball->position.fields.xyz;
    /* This is the collision grid's display midpoint, also valid before the first tick. */
    return (SVECTOR){ (previous->vx + current->vx) / 2, (previous->vy + current->vy) / 2,
        (previous->vz + current->vz) / 2 };
}

static int projectile_in_flight(const WeaponProjectile* projectile)
{
    return !projectile->expiry_frames_left && !projectile->bullet.hit_object
        && !projectile->bullet.motion.fields.world_impact;
}

static ObjectPose* append_object(const Tm4ObjectHeader* header)
{
    if (object_count == object_capacity) {
        size_t capacity = object_capacity ? object_capacity * 2 : 64;
        ObjectPose* poses = realloc(objects, capacity * sizeof(*objects));
        if (!poses)
            return NULL;
        objects = poses;
        object_capacity = capacity;
    }
    ObjectPose* pose = &objects[object_count++];
    pose->address = (uintptr_t)header;
    pose->serial = header->serial;
    return pose;
}

static void capture_objects(void)
{
    object_count = 0;
    for (const Tm4ObjectHeader* header = ObjectLists[OBJECT_LIST_DEFAULT].first; header;
         header = header->next) {
        if (!header->display || (header->flags & OBJECT_CUSTOM_CLASS))
            continue;
        const void* object = ObjectGetPayload(header);
        if (!strcasecmp(header->name, "powerup")) {
            const PowerupState* power = object;
            if (power->position.fields.active != POWERUP_AVAILABLE)
                continue;
            ObjectPose* pose = append_object(header);
            if (pose) {
                pose->pickup.position = power->position.vector;
                pose->pickup.angle = power->angle;
            }
        } else if (!strcasecmp(header->name, "weaponProjectile")) {
            const WeaponProjectile* projectile = object;
            if (!projectile_in_flight(projectile))
                continue;
            ObjectPose* pose = append_object(header);
            if (pose) {
                pose->projectile.transform = projectile->model_to_world;
                pose->projectile.shadow = projectile->bullet.current_world;
                pose->projectile.age = projectile->age_frames;
            }
        } else if (!strcasecmp(header->name, "weaponFireball")) {
            SVECTOR position = fireball_position(object);
            /* The constructor has yet to set the grid position on a newly launched fireball. */
            if (position.vx != header->position.vx || position.vy != header->position.vy
                || position.vz != header->position.vz)
                continue;
            ObjectPose* pose = append_object(header);
            if (pose)
                pose->fireball = position;
        }
    }
}

static const ObjectPose* previous_object(const void* object)
{
    if (!drawing || !completed || fraction >= 1)
        return NULL;
    const Tm4ObjectHeader* header = ObjectGetHeader(object);
    for (size_t i = 0; i < object_count; ++i) {
        if (objects[i].address == (uintptr_t)header && objects[i].serial == header->serial)
            return &objects[i];
    }
    return NULL;
}

void WebInterpolationBeginStep(void)
{
    /* Live simulation state is the newer endpoint after this tick completes. */
    completed = 0;
    capture_objects();
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

static int interpolate_matrix(
    const MATRIX* before, const MATRIX* after, MATRIX* result, s32 maximum_delta)
{
    double right[3], up[3];
    for (int i = 0; i < 3; ++i) {
        /* Discontinuities bypass interpolation when no explicit cut hook ran. */
        if (fabs((double)after->t[i] - before->t[i]) > maximum_delta)
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
                &previous->transform, &camera->camera_to_world, &pose->camera_to_world, 1024))
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
        if (!interpolate_matrix(&previous->transform, &car->transform, &pose->transform, 1024))
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

static int interpolate_position(const SVECTOR* before, const SVECTOR* after, SVECTOR* result,
    s32 maximum_delta)
{
    if (abs(after->vx - before->vx) > maximum_delta || abs(after->vy - before->vy) > maximum_delta
        || abs(after->vz - before->vz) > maximum_delta)
        return 0;
    result->vx = lerp(before->vx, after->vx);
    result->vy = lerp(before->vy, after->vy);
    result->vz = lerp(before->vz, after->vz);
    return 1;
}

#ifdef TM4_WEB_TEST_HOOKS
static int test_capture_motion;

EMSCRIPTEN_KEEPALIVE void WebTestCaptureMotion(int capture)
{
    test_capture_motion = capture;
}

static void trace_motion(const void* object, const char* name, s32 x, s32 y, s32 z, s32 angle,
    s32 render_x, s32 render_y, s32 render_z, s32 render_angle, int flags)
{
    if (!test_capture_motion)
        return;
    EM_ASM(
        {
            tm4Port.motionSamples.push({
                frame : tm4Port.levelFrames,
                tick : tm4Port.simulationTicks,
                id : $0,
                name : UTF8ToString($1),
                live : [ $2, $3, $4, $5 ],
                render : [ $6, $7, $8, $9 ],
                history : !!($10 & 1),
                impact : !!($10 & 2),
                pickup : !!($10 & 4),
                address : $11
            });
        },
        ObjectGetHeader(object)->serial, name, x, y, z, angle, render_x, render_y, render_z,
        render_angle, flags, object);
}
#endif

void WebInterpolationPickup(const PowerupState* power, SVECTOR* position, s32* angle)
{
    *position = power->position.vector;
    *angle = power->angle;
    const ObjectPose* previous = previous_object(power);
    /* Only bob height changes continuously. Repositioned or regenerated pickups cut. */
    int sampled = previous && previous->pickup.position.vx == position->vx
        && previous->pickup.position.vz == position->vz
        && interpolate_position(&previous->pickup.position, position, position, 40);
    if (sampled)
        *angle = lerp_angle(previous->pickup.angle, *angle);
#ifdef TM4_WEB_TEST_HOOKS
    trace_motion(power, power->name, power->position.vector.vx, power->position.vector.vy,
        power->position.vector.vz, power->angle, position->vx, position->vy, position->vz,
        *angle, sampled | 4);
#endif
}

void WebInterpolationProjectile(const WeaponProjectile* projectile, MATRIX* model, SVECTOR* shadow,
    s32 spin_step, s32* angle)
{
    *model = projectile->model_to_world;
    *shadow = projectile->bullet.current_world;
    s32 live_angle = (projectile->age_frames * spin_step) & (ANGLE_FULL_TURN - 1);
    s32 render_angle = live_angle;
    int in_flight = projectile_in_flight(projectile);
    const ObjectPose* previous = previous_object(projectile);
    /* A signed 16-bit flight velocity can travel more than 1024 units in one tick.
     * Impact/expiry state owns visibility and uses the live impact pose. */
    int sampled = previous && in_flight
        && interpolate_matrix(&previous->projectile.transform, &projectile->model_to_world,
            model, 2048);
    if (sampled) {
        interpolate_position(&previous->projectile.shadow, shadow, shadow, 2048);
        s32 previous_angle = (previous->projectile.age * spin_step) & (ANGLE_FULL_TURN - 1);
        render_angle = lerp_angle(previous_angle, live_angle);
    }
    if (angle)
        *angle = render_angle;
#ifdef TM4_WEB_TEST_HOOKS
    const MATRIX* live = &projectile->model_to_world;
    trace_motion(projectile, projectile->type->name, live->t[0], live->t[1], live->t[2],
        live_angle, model->t[0], model->t[1], model->t[2], render_angle,
        sampled | (!in_flight << 1));
#endif
}

void WebInterpolationFireball(const WeaponFireball* fireball, SVECTOR* position)
{
    *position = (SVECTOR){ 0 };
    ObjectCopyPosition(position, fireball);
    const ObjectPose* previous = previous_object(fireball);
    int sampled = previous && interpolate_position(&previous->fireball, position, position, 2048);
#ifdef TM4_WEB_TEST_HOOKS
    const Tm4ShortVectorXYZ* live = &ObjectGetHeader(fireball)->position;
    trace_motion(fireball, "weaponFireball", live->vx, live->vy, live->vz, 0, position->vx,
        position->vy, position->vz, 0, sampled);
#endif
    (void)sampled;
}

void WebInterpolationEndCarDraw(void)
{
    car_identity = car_pose = NULL;
}

const Car* WebInterpolationCarIdentity(const Car* car)
{
    return car == car_pose ? car_identity : car;
}
