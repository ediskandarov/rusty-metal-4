#include "port/web/checkpoint_memory.h"
#include "src/main/object/private.h"
#include "src/modules/car/private.h"
#include "src/modules/levels/w_yard/private.h"
#include "src/modules/lightn/private.h"
#include "src/modules/ray/private.h"
#include "src/modules/weap/private.h"
#include "tm4/main/game.h"
#include "tm4/main/pad.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/light.h"
#include <emscripten.h>
#include <stddef.h>
#include <string.h>

static void matrix_pad(MATRIX* value, u8 byte)
{
    memset((u8*)value + sizeof(value->m), byte, offsetof(MATRIX, t) - sizeof(value->m));
}
static void vector_pad(SVECTOR* value, u8 byte) { memset(&value->pad, byte, sizeof(value->pad)); }

EMSCRIPTEN_KEEPALIVE unsigned WebTestSetSnapshotPadding(unsigned kind, unsigned value)
{
    Car* car = GameInfo.players[0].car;
    Camera* camera = GameInfo.players[0].camera;
    if (!car || !camera)
        return 0;
    switch (kind) {
    case 0:
        matrix_pad(&car->transform, value);
        matrix_pad(&car->previous_transform, value);
        matrix_pad(&car->world_light_matrix, value);
        matrix_pad(&car->color_matrix, value);
        break;
    case 1:
        matrix_pad(&camera->camera_to_world, value);
        matrix_pad(&camera->world_to_camera, value);
        matrix_pad(&camera->previous_camera_to_world, value);
        break;
    case 2:
        vector_pad(&car->position, value);
        vector_pad(&car->previous_position, value);
        break;
    case 3:
        for (CarParticle* p = car->particles; p < car->particle_end; ++p) {
            vector_pad(&p->position, value);
            vector_pad(&p->previous_position, value);
            vector_pad(&p->normal, value);
        }
        break;
    case 4:
        for (CarSpring* p = car->springs; p < car->spring_end; ++p)
            vector_pad(&p->direction, value);
        break;
    case 5:
        for (unsigned i = 0; i < ArrayCount(car->lights); ++i)
            vector_pad(&car->lights[i].light_vector_world, value);
        break;
    case 6:
        for (unsigned i = 0; i < ArrayCount(car->controls.input_history); ++i)
            memset(&car->controls.input_history[i].padding, value,
                sizeof(car->controls.input_history[i].padding));
        break;
    case 7:
        PadJpad[0].reserved03 = value;
        break;
    case 8: {
        unsigned count = 0;
        for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list)
            for (Tm4ObjectHeader* object = ObjectLists[list].first; object; object = object->next)
                if (!strcmp(object->name, "crane")) {
                    Crane* crane = ObjectGetPayload(object);
                    matrix_pad(&crane->transform, value);
                    vector_pad(&crane->magnet_position, value);
                    ++count;
                }
        return count;
    }
    default:
        return 0;
    }
    return 1;
}

EMSCRIPTEN_KEEPALIVE unsigned WebTestCreateRarePaddingEffect(unsigned kind)
{
    Car* car = GameInfo.players[0].car;
    if (!car)
        return 0;
    void* effect = NULL;
    WebCheckpointArenaSelect(1);
    switch (kind) {
    case 0:
        effect
            = ObjectCreate("weaponBomb", OBJECT_DESTROY_WITH_OWNER, car, "remote", &car->position);
        break;
    case 1:
        if (RayClassCount)
            effect = ObjectCreate("weaponRayBeam", OBJECT_DESTROY_WITH_OWNER, car, &car->transform,
                RayClasses[0].name, 0, 1);
        break;
    case 2:
        if (LightnClassCount)
            effect = ObjectCreate("weaponLightningEmitter", OBJECT_DESTROY_WITH_OWNER, car,
                LightnClasses[0].name, &car->position);
        break;
    case 3:
        effect = ObjectCreate("lightEmitter", OBJECT_DESTROY_WITH_OWNER, car,
            LIGHT_EMITTER_POSITION | LIGHT_EMITTER_DIRECTION | LIGHT_EMITTER_INTENSITY, 255, 128,
            64, 2048, ONE, car->position.vx, car->position.vy, car->position.vz, 0, -ONE, 0);
        break;
    case 4:
        effect = CarDisplayJumpConstructor(car);
        break;
    }
    WebCheckpointArenaSelect(0);
    return effect != NULL;
}

/* value > 255 queries live coverage without modifying the object. */
EMSCRIPTEN_KEEPALIVE unsigned WebTestRareEffectPadding(unsigned field, unsigned value)
{
    unsigned count = 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* object = ObjectLists[list].first; object; object = object->next) {
            void* payload = ObjectGetPayload(object);
            MATRIX* matrix = NULL;
            SVECTOR* vector = NULL;
            unsigned vectors = 1;
            if (!strcmp(object->name, "weaponBomb") && field == 0)
                matrix = &((WeaponBomb*)payload)->transform;
            else if (!strcmp(object->name, "weaponRayBeam")) {
                RayBeam* ray = payload;
                if (field == 1)
                    matrix = &ray->placement;
                if (field == 2)
                    matrix = &ray->beam_to_world;
                if (field == 3)
                    vector = &ray->hit_world;
            } else if (!strcmp(object->name, "weaponLightning")) {
                Lightning* bolt = payload;
                if (field == 4)
                    matrix = &bolt->matrix;
                if (field == 5)
                    vector = &bolt->start;
                if (field == 6)
                    vector = &bolt->end;
                if (field == 7) {
                    vector = bolt->points;
                    vectors = ArrayCount(bolt->points);
                }
            } else if (!strcmp(object->name, "lightEmitter")) {
                LightEmitter* light = payload;
                if (field == 8)
                    vector = &light->previous_world_position;
                if (field == 9)
                    vector = &light->world_position;
                if (field == 10)
                    vector = &light->direction_world;
            } else if (!strcmp(object->name, "carJump")) {
                CarJump* jump = payload;
                if (field == 11)
                    vector = &jump->world_position;
                if (field == 12)
                    vector = &jump->frame_displacement;
            }
            if (matrix) {
                if (value <= 255)
                    matrix_pad(matrix, value);
                ++count;
            }
            if (vector) {
                for (unsigned i = 0; i < vectors; ++i)
                    if (value <= 255)
                        vector_pad(&vector[i], value);
                count += vectors;
            }
        }
    }
    return count;
}
