#include "port/web/module_import.h"
#include "port/web/net_match.h"
#include "teleport_runtime.h"
#include "tm4/main/game.h"
#include "tm4/main/math3d.h"
#include "tm4/main/object.h"
#include "tm4/main/registry.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/car.h"
#include "tm4/modules/car_ai.h"
#include "tm4/modules/sound.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const Rm4TeleportEffects* effects;

void WebTeleportLoad(void)
{
    effects = NULL;
    RegistryFile* file = RegGetFilePtrS("/world/teleportEffects");
    if (!file)
        return;
    if (RegGetFileTypeP(file) != REG_FILE_TYPE_STRING) {
        fprintf(stderr, "world/teleportEffects must be a symbol string\n");
        abort();
    }
    char* name = RegGetFileDataP(file);
    const Rm4TeleportEffects* candidate = (void*)OSSymbolGetAddress(name);
    if (!candidate || candidate->version != RM4_TELEPORT_EFFECTS_VERSION
        || candidate->size != sizeof(*candidate) || (candidate->flags & ~RM4_TELEPORT_REPLACE_AUDIO)
        || !candidate->arrived) {
        fprintf(stderr, "Invalid teleport effects provider: %s\n", name);
        abort();
    }
    effects = candidate;
}

void WebTeleportUnload(void)
{
    effects = NULL;
}

int WebTeleportAppearance(RegistryDirectory* registry, const char** custom)
{
    *custom = NULL;
    RegistryFile* file = RegGetFilePtrPS(registry, "appearance");
    if (!file)
        return 1;
    if (RegGetFileTypeP(file) != REG_FILE_TYPE_STRING)
        return -1;
    const char* name = RegGetFileDataP(file);
    if (!strcmp(name, "original"))
        return 1;
    if (!strcmp(name, "none"))
        return 0;
    if (!name[0])
        return -1;
    *custom = name;
    return 0;
}

int WebTeleportAttachAppearance(
    void* portal, const char* custom, const Rm4TeleportAppearanceContext* context)
{
    if (!custom)
        return 1;
    if (!ObjectCreate((char*)custom,
            OBJECT_HAS_OWNER | OBJECT_DESTROY_WITH_OWNER | OBJECT_FOLLOW_OWNER, portal, context)) {
        fprintf(stderr, "Could not create teleport appearance class: %s\n", custom);
        return 0;
    }
    return 1;
}

int WebTeleportCar(Car* car, const Rm4TeleportRequest* request)
{
    if (!car || !request || (!request->forward.vx && !request->forward.vz))
        return 0;
    /* Copy the request first: it may refer to data inside the relocated object. */
    Rm4TeleportRequest target = *request;
    Rm4TeleportEvent event = { .car = car, .source = target.source, .before = car->transform };
    MATRIX matrix = { 0 };
    matrix.t[0] = target.destination.vx;
    matrix.t[1] = target.destination.vy;
    matrix.t[2] = target.destination.vz;
    matrix.m[0][2] = target.forward.vx;
    matrix.m[1][2] = target.forward.vy;
    matrix.m[2][2] = target.forward.vz;
    matrix.m[0][0] = target.forward.vz;
    matrix.m[2][0] = -target.forward.vx;
    NormalizeMatrixWithBasis(&matrix, 2, 0);
    (WEB_MODULE("car", CarOrientWithMatrix))(car, &matrix);
    s32 slot = car->controller_index;
    if (slot >= 0 && slot < ArrayCount(GameInfo.players)
        && (WebNetMatchActive() ? WebNetSlotOccupied(slot) : slot < GameInfo.player_count)) {
        Camera* camera = GameInfo.players[slot].camera;
        if (camera && camera->object == car && camera->data)
            ((CarCameraState*)camera->data)->snap = 1;
    }
    (WEB_MODULE("car", CarAiMovedThroughTeleporter))(car);
    event.after = car->transform;
    if (!effects || !(effects->flags & RM4_TELEPORT_REPLACE_AUDIO)) {
        /* Preserve TM4's two post-move sound placements. */
        ObjectCreate("soundEmitter", 0, "teleporter", SOUND_EMITTER_POSITION, car->position.vx,
            car->position.vy, car->position.vz);
        ObjectCreate("soundEmitter", 0, "teleporter", SOUND_EMITTER_POSITION, target.destination.vx,
            target.destination.vy, target.destination.vz);
    }
    if (effects)
        effects->arrived(&event);
    return 1;
}
