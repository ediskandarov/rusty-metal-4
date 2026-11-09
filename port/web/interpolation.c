#include <LIBGTE.H>
#include "interpolation.h"
#include "src/modules/afc/private.h"
#include "src/modules/anim/private.h"
#include "src/modules/carprt/private.h"
#include "src/modules/cars/c_crush/private.h"
#include "src/modules/cars/c_toy/private.h"
#include "src/modules/cars/shovel.h"
#include "src/modules/frag/private.h"
#include "src/modules/levels/w_carni/private.h"
#include "src/modules/levels/w_neon/private.h"
#include "src/modules/levels/w_oil/private.h"
#include "src/modules/levels/w_yard/private.h"
#include "src/modules/lightn/private.h"
#include "src/modules/weap/private.h"
#include "tm4/fixed.h"
#include "tm4/main/game.h"
#include "tm4/main/math3d.h"
#include "tm4/main/object.h"
#include "tm4/main/system.h"
#include "tm4/modules/auger.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/car.h"
#include "tm4/modules/ray.h"
#include "tm4/modules/tele.h"
#include <emscripten.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

typedef struct {
    u32 serial;
    uintptr_t address;
    MATRIX transform;
    const void* accessory;
    s32 accessory_angles[2];
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
    SVECTOR position;
    union {
        struct {
            MATRIX transform;
            uintptr_t rider;
            s32 top_angle, tail_angle, ground;
        } scene;
        struct {
            MATRIX transform;
            s32 length;
            uintptr_t owner;
        } ray;
        struct {
            SVECTOR start, end;
            uintptr_t target;
        } lightning;
        struct {
            s16 angle, size;
        } afc;
        struct {
            size_t first, count;
        } anim;
        s32 portal_size;
        struct {
            u16 outer, inner, height;
        } wave;
        struct {
            SVECTOR position;
            s16 angle;
        } pickup;
        struct {
            MATRIX transform;
            SVECTOR shadow;
            u32 age;
            SVECTOR trail_tip[4];
            int has_ribbon;
        } projectile;
        struct {
            SVECTOR head, tail;
        } bullet;
        SVECTOR fireball;
    };
} ObjectPose;

typedef struct {
    s16 width, height;
    int visible;
} AnimSize;

static AnimSize* anim_sizes;
static size_t anim_size_count, anim_size_capacity;
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
MATRIX* CarCrusherDisplaySpecialGroupDisplay(Car*, s32, CarRenderGroup*, MATRIX*, void*);
MATRIX* CarSlamDisplaySpecialGroupDisplay(Car*, s32, CarRenderGroup*, MATRIX*, void*);
MATRIX* CarToyDisplaySpecialGroupDisplay(Car*, s32, CarRenderGroup*, MATRIX*, void*);
MATRIX* CarTrashDisplaySpecialGroupDisplay(Car*, s32, CarRenderGroup*, MATRIX*, void*);

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
    anim_size_count = 0;
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

static int bullet_in_flight(const Bullet* bullet)
{
    return !bullet->hit_object && !bullet->motion.fields.world_impact;
}

static int trail_tip(const WeaponProjectile* projectile, SVECTOR tip[4])
{
    s32 index = projectile->trail_sample_index;
    if (projectile->trail_color_step.channels.mode != WEAPON_TRAIL_RIBBON || index < 0
        || index >= projectile->trail_sample_count || index >= WEAPON_TRAIL_SAMPLE_CAPACITY)
        return 0;
    for (s32 i = 0; i < 4; ++i) {
        const WeaponTrailPoint* point = &projectile->trail_world[i][index];
        tip[i] = (SVECTOR){ point->vx, point->vy, point->vz };
    }
    return 1;
}

static int projectile_in_flight(const WeaponProjectile* projectile)
{
    return !projectile->expiry_frames_left && bullet_in_flight(&projectile->bullet);
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
    pose->position = (SVECTOR){ header->position.vx, header->position.vy, header->position.vz };
    return pose;
}

static void capture_model(const Tm4ObjectHeader* header, const MATRIX* transform,
    s32 top_angle, s32 tail_angle, s32 ground)
{
    ObjectPose* pose = append_object(header);
    if (!pose)
        return;
    pose->scene.transform = *transform;
    pose->scene.rider = (uintptr_t)header->owner;
    pose->scene.top_angle = top_angle;
    pose->scene.tail_angle = tail_angle;
    pose->scene.ground = ground;
}

static void capture_anim(const Tm4ObjectHeader* header, const Anim* anim)
{
    ObjectPose* pose = append_object(header);
    if (!pose)
        return;
    pose->anim.first = anim_size_count;
    pose->anim.count = 0;
    size_t count = anim->type->part_count;
    if (anim_size_count + count > anim_size_capacity) {
        size_t capacity = anim_size_capacity ? anim_size_capacity * 2 : 64;
        if (capacity < anim_size_count + count)
            capacity = anim_size_count + count;
        AnimSize* sizes = realloc(anim_sizes, capacity * sizeof(*anim_sizes));
        if (!sizes)
            return;
        anim_sizes = sizes;
        anim_size_capacity = capacity;
    }
    pose->anim.count = count;
    for (size_t i = 0; i < count; ++i) {
        const AnimPart* part = &anim->parts[i];
        AnimSize* size = &anim_sizes[anim_size_count++];
        size->width = part->width;
        size->height = part->height;
        size->visible = anim->type->parts[i].start_frame < anim->age_frames
            && part->texture_elapsed_frames != ANIM_TEXTURE_FINISHED;
    }
}

static int compare_object_address(const void* left, const void* right)
{
    const ObjectPose* a = left;
    const ObjectPose* b = right;
    return (a->address > b->address) - (a->address < b->address);
}

static void capture_objects(void)
{
    object_count = 0;
    anim_size_count = 0;
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
                pose->projectile.has_ribbon = trail_tip(projectile, pose->projectile.trail_tip);
            }
        } else if (!strcasecmp(header->name, "bullet")) {
            const Bullet* bullet = object;
            if (!bullet_in_flight(bullet))
                continue;
            ObjectPose* pose = append_object(header);
            if (pose) {
                pose->bullet.head = bullet->current_world;
                pose->bullet.tail = bullet->previous_world;
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
        } else if (!strcasecmp(header->name, "weaponRayBeam")) {
            const RayBeam* ray = object;
            ObjectPose* pose = append_object(header);
            if (pose) {
                pose->ray.transform = ray->beam_to_world;
                pose->ray.length = ray->length;
                pose->ray.owner = (uintptr_t)header->owner;
            }
        } else if (!strcasecmp(header->name, "weaponLightning")) {
            const Lightning* bolt = object;
            if (!bolt->point_count)
                continue;
            ObjectPose* pose = append_object(header);
            if (pose) {
                pose->lightning.start = bolt->start;
                pose->lightning.end = bolt->end;
                pose->lightning.target = (uintptr_t)bolt->target;
            }
        } else if (!strcasecmp(header->name, "train")) {
            const Train* train = object;
            capture_model(header, &train->path.local_to_world, 0, 0, 0);
        } else if (!strcasecmp(header->name, "coaster")) {
            const Coaster* coaster = object;
            capture_model(header, &coaster->path.local_to_world, 0, 0, 0);
        } else if (!strcasecmp(header->name, "ufo")) {
            const Ufo* ufo = object;
            capture_model(header, &ufo->path.local_to_world, 0, 0, 0);
        } else if (!strcasecmp(header->name, "helicopter")) {
            const Helicopter* helicopter = object;
            capture_model(header, &helicopter->path.local_to_world, helicopter->top_blade_angle,
                helicopter->tail_blade_angle, 0);
        } else if (!strcasecmp(header->name, "crane")) {
            const Crane* crane = object;
            capture_model(header, &crane->transform, 0, 0, crane->ground_y);
        } else if (!strcasecmp(header->name, "fragment")) {
            const Fragment* fragment = object;
            capture_model(header, &fragment->local_to_world, 0, 0, 0);
        } else if (!strcasecmp(header->name, "carpart")) {
            const Carpart* part = object;
            capture_model(header, &part->local_to_world, 0, 0, 0);
        } else if (!strcasecmp(header->name, "afc")) {
            const Afc* flare = object;
            ObjectPose* pose = append_object(header);
            if (pose) {
                pose->afc.angle = flare->rotation_angle;
                pose->afc.size = flare->size;
            }
        } else if (!strcasecmp(header->name, "anim")) {
            capture_anim(header, object);
        } else if (!strcasecmp(header->name, "teleporter")) {
            const Teleporter* portal = object;
            ObjectPose* pose = append_object(header);
            if (pose)
                pose->portal_size = portal->billboard_size;
        } else if (!strcasecmp(header->name, "explosionShockWave")) {
            const ExplosionWave* wave = object;
            ObjectPose* pose = append_object(header);
            if (pose) {
                pose->wave.outer = wave->outer_radius;
                pose->wave.inner = wave->inner_radius;
                pose->wave.height = wave->height;
            }
        }
    }
    if (object_count > 1)
        qsort(objects, object_count, sizeof(*objects), compare_object_address);
}

static const ObjectPose* previous_object(const void* object)
{
    if (!drawing || !completed || fraction >= 1)
        return NULL;
    const Tm4ObjectHeader* header = ObjectGetHeader(object);
    if (!object_count)
        return NULL;
    const ObjectPose key = { .address = (uintptr_t)header };
    const ObjectPose* pose
        = bsearch(&key, objects, object_count, sizeof(*objects), compare_object_address);
    return pose && pose->serial == header->serial ? pose : NULL;
}

static void capture_accessory(const Car* car, CarPose* pose)
{
    const void* context = car->callback_context;
    if (!context)
        return;
    if (car->render_callback == CarAugerDisplaySpecialGroupDisplay) {
        const AugerDrill* drill = context;
        pose->accessory_angles[0] = drill->angle;
    } else if (car->render_callback == CarToyDisplaySpecialGroupDisplay) {
        const ToyWindup* windup = context;
        pose->accessory_angles[0] = windup->angle;
    } else if (car->render_callback == CarSlamDisplaySpecialGroupDisplay || car->render_callback == CarTrashDisplaySpecialGroupDisplay) {
        const CarShovelState* shovel = context;
        pose->accessory_angles[0] = shovel->angle;
    } else if (car->render_callback == CarCrusherDisplaySpecialGroupDisplay) {
        const CrusherPinchers* pinchers = context;
        pose->accessory_angles[0] = pinchers->upper_angle;
        pose->accessory_angles[1] = pinchers->lower_angle;
    } else {
        return;
    }
    pose->accessory = context;
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
        pose->address = (uintptr_t)car;
        pose->transform = car->transform;
        capture_accessory(car, pose);
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

static const CarPose* previous_car(const Car* car)
{
    if (!drawing || !completed || fraction >= 1)
        return NULL;
    u32 id = serial(car);
    for (s32 i = 0; i < ArrayCount(cars); ++i) {
        if (cars[i].serial == id && cars[i].address == (uintptr_t)car)
            return &cars[i];
    }
    return NULL;
}

Car* WebInterpolationCar(Car* car, Car* pose)
{
    const CarPose* previous = previous_car(car);
    if (previous) {
        *pose = *car;
        if (!interpolate_matrix(&previous->transform, &car->transform, &pose->transform, 1024))
            return car;
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

void WebInterpolationBullet(const Bullet* bullet, SVECTOR* head, SVECTOR* tail)
{
    *head = bullet->current_world;
    *tail = bullet->previous_world;
    const ObjectPose* previous = previous_object(bullet);
    int in_flight = bullet_in_flight(bullet);
    SVECTOR render_head = *head, render_tail = *tail;
    /* Sample both ends of the visible segment together. An impact keeps the clipped
     * segment and follows its original removal tick. */
    int sampled = previous && in_flight
        && interpolate_position(&previous->bullet.head, head, &render_head, 2048)
        && interpolate_position(&previous->bullet.tail, tail, &render_tail, 2048);
    if (sampled) {
        *head = render_head;
        *tail = render_tail;
    }
#ifdef TM4_WEB_TEST_HOOKS
    trace_motion(bullet, "bullet head", bullet->current_world.vx, bullet->current_world.vy,
        bullet->current_world.vz, 0, head->vx, head->vy, head->vz, 0, sampled | (!in_flight << 1));
    trace_motion(bullet, "bullet tail", bullet->previous_world.vx, bullet->previous_world.vy,
        bullet->previous_world.vz, 0, tail->vx, tail->vy, tail->vz, 0, sampled | (!in_flight << 1));
#endif
}

int WebInterpolationTrailTip(const WeaponProjectile* projectile, SVECTOR tip[4])
{
    const ObjectPose* previous = previous_object(projectile);
    SVECTOR current[4];
    if (!previous || !previous->projectile.has_ribbon || !projectile_in_flight(projectile)
        || !trail_tip(projectile, current))
        return 0;
    for (s32 i = 0; i < 4; ++i) {
        if (!interpolate_position(&previous->projectile.trail_tip[i], &current[i], &tip[i], 2048))
            return 0;
    }
    return 1;
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

MATRIX* WebInterpolationSceneModel(const void* object, MATRIX* live, MATRIX* sample)
{
    const ObjectPose* previous = previous_object(object);
    const Tm4ObjectHeader* header = ObjectGetHeader(object);
    int sampled = previous && previous->scene.rider == (uintptr_t)header->owner
        && interpolate_matrix(&previous->scene.transform, live, sample, 1024);
    MATRIX* result = sampled ? sample : live;
#ifdef TM4_WEB_TEST_HOOKS
    trace_motion(object, header->name, live->t[0], live->t[1], live->t[2], live->m[0][0],
        result->t[0], result->t[1], result->t[2], result->m[0][0], sampled);
#endif
    return result;
}

s32 WebInterpolationAngle(s32 previous, s32 current)
{
    return drawing && completed && fraction < 1 ? lerp_angle(previous, current) : current;
}

void WebInterpolationSceneRotors(const void* object, s32* top, s32* tail)
{
    const ObjectPose* previous = previous_object(object);
    if (previous) {
        *top = lerp_angle(previous->scene.top_angle, *top);
        *tail = lerp_angle(previous->scene.tail_angle, *tail);
    }
}

s32 WebInterpolationCraneGround(const void* crane, s32 current)
{
    const ObjectPose* previous = previous_object(crane);
    if (previous && previous->scene.rider == (uintptr_t)ObjectGetHeader(crane)->owner
        && abs(previous->scene.ground - current) <= 128)
        return lerp(previous->scene.ground, current);
    return current;
}

s32 WebInterpolationCarAccessory(const Car* car, s32 slot, s32 angle)
{
    const Car* identity = WebInterpolationCarIdentity(car);
    const CarPose* previous = previous_car(identity);
    int sampled = previous && previous->accessory && previous->accessory == car->callback_context;
    s32 render = sampled ? lerp_angle(previous->accessory_angles[slot], angle) : angle;
#ifdef TM4_WEB_TEST_HOOKS
    trace_motion(identity, slot ? "car accessory lower" : "car accessory", 0, 0, 0, angle,
        0, 0, 0, render, sampled);
#endif
    return render;
}

MATRIX* WebInterpolationCarTransform(const Car* car, MATRIX* sample)
{
    const CarPose* previous = previous_car(car);
    if (!previous || !interpolate_matrix(&previous->transform, &car->transform, sample, 1024))
        *sample = car->transform;
    return sample;
}

void WebInterpolationCarPoint(const Car* car, const SVECTOR* point, SVECTOR* sample)
{
    MATRIX transform;
    WebInterpolationCarTransform(car, &transform);
    *sample = *point;
    sample->vx += transform.t[0] - car->transform.t[0];
    sample->vy += transform.t[1] - car->transform.t[1];
    sample->vz += transform.t[2] - car->transform.t[2];
}

MATRIX* WebInterpolationRay(const RayBeam* ray, MATRIX* live, MATRIX* sample, s32* length)
{
    const ObjectPose* previous = previous_object(ray);
    const Tm4ObjectHeader* header = ObjectGetHeader(ray);
    s32 live_length = *length;
    int sampled = previous && previous->ray.owner == (uintptr_t)header->owner
        && live_length >= previous->ray.length
        && interpolate_matrix(&previous->ray.transform, live, sample, 2048);
    if (sampled)
        *length = lerp(previous->ray.length, live_length);
    MATRIX* result = sampled ? sample : live;
#ifdef TM4_WEB_TEST_HOOKS
    trace_motion(ray, header->name, live->t[0], live->t[1], live->t[2], live_length,
        result->t[0], result->t[1], result->t[2], *length, sampled);
#endif
    return result;
}

static double bolt_distance(const SVECTOR* start, const SVECTOR* end)
{
    double x = end->vx - start->vx, y = end->vy - start->vy, z = end->vz - start->vz;
    return sqrt(x * x + y * y + z * z);
}

int WebInterpolationLightning(const Lightning* bolt, MATRIX* transform, SVECTOR* points)
{
    const ObjectPose* previous = previous_object(bolt);
    SVECTOR start, end;
    if (!previous || previous->lightning.target != (uintptr_t)bolt->target
        || !bolt->point_count || bolt->point_count > LIGHTNING_POINT_CAPACITY
        || !interpolate_position(&previous->lightning.start, &bolt->start, &start, 2048)
        || !interpolate_position(&previous->lightning.end, &bolt->end, &end, 2048))
        return 0;
    double live_length = bolt_distance(&bolt->start, &bolt->end);
    double length = bolt_distance(&start, &end);
    if (live_length < 1 || length < 1)
        return 0;
    *transform = bolt->matrix;
    transform->t[0] = start.vx;
    transform->t[1] = start.vy;
    transform->t[2] = start.vz;
    transform->m[0][1] = lround(ONE * (end.vx - start.vx) / length);
    transform->m[1][1] = lround(ONE * (end.vy - start.vy) / length);
    transform->m[2][1] = lround(ONE * (end.vz - start.vz) / length);
    transform->m[0][0] = transform->m[2][1];
    transform->m[1][0] = 0;
    transform->m[2][0] = -transform->m[0][1];
    if (!transform->m[0][0] && !transform->m[2][0])
        transform->m[0][0] = ONE;
    PushMatrix();
    NormalizeMatrixWithBasis(transform, 1, 0);
    PopMatrix();
    /* The jagged points come from this simulation tick. Slide them along the new
     * span so their flicker and the contact sprite retain the same sampled anchor. */
    for (s32 i = 0; i < bolt->point_count; ++i) {
        points[i] = bolt->points[i];
        points[i].vy = lround(points[i].vy * length / live_length);
    }
#ifdef TM4_WEB_TEST_HOOKS
    trace_motion(bolt, "lightning endpoint", bolt->end.vx, bolt->end.vy, bolt->end.vz, 0,
        end.vx, end.vy, end.vz, 0, 1);
#endif
    return 1;
}

void WebInterpolationObjectPosition(const void* object, SVECTOR* position)
{
    *position = (SVECTOR){ 0 };
    ObjectCopyPosition(position, object);
    const ObjectPose* previous = previous_object(object);
    if (previous)
        interpolate_position(&previous->position, position, position, 1024);
}

void WebInterpolationAfc(const Afc* object, s32* angle, s16* size)
{
    const ObjectPose* previous = previous_object(object);
    if (previous) {
        if (object->rotation_step)
            *angle = lerp_angle(previous->afc.angle, *angle);
        *size = lerp(previous->afc.size, *size);
    }
}

s32 WebInterpolationPortalSize(const void* portal, s32 size)
{
    const ObjectPose* previous = previous_object(portal);
    return previous ? lerp(previous->portal_size, size) : size;
}

void WebInterpolationAnimSize(const void* animation, s32 part, s32* width, s32* height)
{
    const ObjectPose* previous = previous_object(animation);
    if (!previous || (size_t)part >= previous->anim.count)
        return;
    const AnimSize* size = &anim_sizes[previous->anim.first + part];
    if (size->visible) {
        *width = lerp(size->width, *width);
        *height = lerp(size->height, *height);
    }
}

void WebInterpolationWave(const ExplosionWave* wave, s32* outer, s32* inner, s32* height)
{
    const ObjectPose* previous = previous_object(wave);
    if (previous) {
        *outer = lerp(previous->wave.outer, *outer);
        *inner = lerp(previous->wave.inner, *inner);
        *height = lerp(previous->wave.height, *height);
    }
}

void WebInterpolationEndCarDraw(void)
{
    car_identity = car_pose = NULL;
}

const Car* WebInterpolationCarIdentity(const Car* car)
{
    return car == car_pose ? car_identity : car;
}
