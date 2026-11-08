#include "src/modules/levels/w_yard/private.h"
#include "../../overlays.h"
#include <emscripten.h>
#include <string.h>

extern s32 CraneSizeof, CraneCameraSizeof, DeathPointSizeof;
void CraneClassConstructor(RegistryDirectory*);
s32 CraneInstanceConstructor(Crane*, RegistryDirectory*);
void CraneProcess(Crane*);
void CraneDisplay(Crane*, Tm4OrderingTag*, u8**, u8*, MATRIX*);
void CraneDestructor(Crane*);
void CraneCameraProcess(void*, Camera*, void*);
s32 DeathPointInstanceConstructor(DeathPoint*, RegistryDirectory*);
void DeathPointProcess(DeathPoint*);
void DeathPointDestructor(DeathPoint*);
void InteractCarWithDeathPoint(Car*, DeathPoint*);

static void construct_class(RegistryDirectory* directory)
{
    OSRegisterCarAi();
    OSRegisterCarPhysics();
    OSRegisterCar();
    OSRegisterSoundEmitter();
    OSRegisterExplosion();
    OSRegisterInteract();
    CraneClassConstructor(directory);
}
static s32 construct(void* object, RegistryDirectory* directory)
{
    s32 result = CraneInstanceConstructor(object, directory);
    if (result)
        EM_ASM({ tm4Port.craneInstances = (tm4Port.craneInstances || 0) + 1; });
    return result;
}
static void process(void* object)
{
    Crane* crane = object;
    if (GameInfo.game_type == GAME_TYPE_TOURNAMENT && GameInfo.bosses_spawned) {
        CraneProcess(crane);
        EM_ASM({ tm4Port.craneDestroyed = (tm4Port.craneDestroyed || 0) + 1; });
        return;
    }
    CraneProcess(crane);
    EM_ASM(
        {
            tm4Port.crane = ({
                angle : $0,
                controlled : !!$1,
                holding : !!$2,
                cameraAttached : !!$3,
                magnet : [ $4, $5, $6 ],
                ground : $7,
                radius : $8,
                heldY : $9,
                springY : $10
            });
        },
        crane->rotation_angle, crane->control->operator_car != NULL, crane->held_car != NULL,
        GameInfo.players[0].camera && GameInfo.players[0].camera->object == crane,
        crane->control->operator_car ? crane->magnet_position.vx : 0,
        crane->control->operator_car ? crane->magnet_position.vy : 0,
        crane->control->operator_car ? crane->magnet_position.vz : 0,
        crane->control->operator_car ? crane->ground_y : 0, crane->magnet_radius,
        crane->held_car ? crane->held_car->position.vy : 0,
        crane->held_car ? crane->held_car->particles[0].external_force.vy : 0);
}
static void display(void* object, Tm4OrderingTag* table, u8** cursor, u8* end, MATRIX* view)
{
    u8* start = *cursor;
    CraneDisplay(object, table, cursor, end, view);
    if (*cursor != start)
        EM_ASM({ tm4Port.craneDraws = (tm4Port.craneDraws || 0) + 1; });
}
static void destroy(void* object)
{
    CraneDestructor(object);
    EM_ASM({ tm4Port.craneRemoved = (tm4Port.craneRemoved || 0) + 1; });
}
static s32 deathpoint_instance(void* object, RegistryDirectory* directory)
{
    OSRegisterCarPhysics();
    return DeathPointInstanceConstructor(object, directory);
}
OSWord WebYardExport(const char* name)
{
#define EXPORT(key, value)                                                                         \
    if (!strcmp(name, key))                                                                        \
    return (OSWord)(value)
    EXPORT("CraneClassConstructor", construct_class);
    EXPORT("CraneInstanceConstructor", construct);
    EXPORT("CraneProcess", process);
    EXPORT("CraneDisplay", display);
    EXPORT("CraneDestructor", destroy);
    EXPORT("DeathPointInstanceConstructor", deathpoint_instance);
#undef EXPORT
    return 0;
}
