#include "port/web/checkpoint_memory.h"
#include "port/web/net_match.h"
#include "port/web/overlays.h"
#include "port/web/snapshot_types.h"
#include "src/main/object/private.h"
#include "tm4/main/game.h"
#include "tm4/main/system.h"
#include "tm4/main/world.h"
#include "tm4/modules/car.h"
#include <emscripten.h>

EMSCRIPTEN_KEEPALIVE void WebTestObjectRegistry(const char* module)
{
    s32 objects = 0, bindings = 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list)
        for (Tm4ObjectHeader* h = ObjectLists[list].first; h; h = h->next)
            ++objects;
    for (s32 i = 0; i < OBJECT_CLASS_LIMIT; ++i) {
        Tm4ObjectHeader h = { .class_index = i };
        bindings += WebSnapshotObjectType(&h) != NULL;
    }
    EM_ASM(
        {
            tm4Port.testObjectRegistry = ({
                classes : [],
                pairs : [],
                objects : $0,
                bindings : $1,
                tables : !!$2 || !!$3,
                moduleLoaded : !!$4
            });
        },
        objects, bindings, ObjectClasses, ObjectInteractionPairs,
        module && *module ? WebNativeModuleLoaded(module) : 0);
    for (s32 i = 0; i < ObjectClassCount; ++i) {
        EM_ASM(
            { tm4Port.testObjectRegistry.classes.push(UTF8ToString($0)); }, ObjectClasses[i].name);
        for (s32 j = 0; j <= i; ++j) {
            const Tm4ObjectPair* pair = &ObjectInteractionPairs[i * (i + 1) / 2 + j];
            if (pair->callback)
                EM_ASM(
                    {
                        tm4Port.testObjectRegistry.pairs.push(
                            [ UTF8ToString($0), UTF8ToString($1), $2 ]);
                    },
                    ObjectClasses[j].name, ObjectClasses[i].name, pair->reversed);
        }
    }
}

/* Real fragment physics and collision; create the fixture before capturing a snapshot. */
EMSCRIPTEN_KEEPALIVE int WebTestDropFragments(void)
{
    Car* car = GameInfo.players[0].car;
    const Tm4DisplayFace* face = RegGetFileDataS("/world/displayPolys/faceData");
    const SVECTOR* vertices = RegGetFileDataS("/world/displayPolys/vertexData");
    if (!car || !face || !vertices || !WebNetMatchActive())
        return 0;
    SVECTOR position = { car->position.vx, car->position.vy - 200, car->position.vz, 0 };
    VECTOR velocity = { 0 };
    WebCheckpointArenaSelect(1);
    int count = 0;
    for (int i = 0; i < 8; ++i)
        count += ObjectCreate("fragment", 0, face, vertices, &position, &velocity, NULL) != NULL;
    WebCheckpointArenaSelect(0);
    srandrand(0);
    return count;
}
