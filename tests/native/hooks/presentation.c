#include "../hooks.h"
#include "port/web/checkpoint_memory.h"
#include "port/web/net_match.h"
#include "port/web/overlays.h"
#include "src/modules/car/private.h"
#include "src/modules/menu/private.h"
#include "tm4/main/game.h"
#include "tm4/main/object.h"
#include "tm4/main/pad.h"
#include "tm4/main/system.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/tele.h"
#include <emscripten.h>
#include <strings.h>

/* Exercise the actual teleport paths before the next camera process consumes snap. */
EMSCRIPTEN_KEEPALIVE int WebTestTeleportCamera(s32 slot, s32 hyperspace)
{
    if (slot < 0 || slot >= ArrayCount(GameInfo.players))
        return -1;
    Tm4GamePlayer* player = &GameInfo.players[slot];
    if (!player->car || !player->camera || player->camera->object != player->car)
        return -1;
    CarCameraState* state = player->camera->data;
    state->snap = 0;
    if (hyperspace) {
        CarAiInputCallback input = player->car->ai_input_callback;
        player->car->ai_input_callback = NULL;
        player->car->controls.action = CarActionHyperspace;
        CarProcess(player->car);
        player->car->ai_input_callback = input;
    } else {
        Teleporter portal = { 0 };
        portal.destination_world = player->car->position;
        portal.destination_world.vx += 1024;
        portal.destination_forward_world.vz = ONE;
        void (*interact)(void*, void*) = (void*)WebInteractExport("InteractCarWithTeleporter");
        interact(player->car, &portal);
    }
    return state->snap;
}
/* The random spawn can start with only one pickup type inside the camera view. */
EMSCRIPTEN_KEEPALIVE int WebTestPlaceMotionPickups(void)
{
    const Camera* camera = GameInfo.players[0].camera;
    if (!camera)
        return 0;
    const MATRIX* view = &camera->camera_to_world;
    int count = 0;
    for (s32 side = -1; side <= 1; side += 2) {
        s32 position[3];
        for (s32 i = 0; i < 3; ++i)
            position[i] = view->t[i] + (view->m[i][2] * 750 + view->m[i][0] * side * 175) / ONE;
        if (ObjectCreate("powerup", 0, side < 0 ? "health" : "homing", -1, -1, position[0],
                position[1], position[2]))
            ++count;
    }
    return count;
}

/* Launch in the active view so the motion check is independent of Rain's landing site. */
EMSCRIPTEN_KEEPALIVE u32 WebTestSpawnMotionFireball(void)
{
    const Car* car = GameInfo.players[0].car;
    if (!car)
        return 0;
    const MATRIX* transform = &car->transform;
    s32 forward_x = transform->m[0][2], forward_z = transform->m[2][2];
    SVECTOR position = { transform->t[0] + forward_x / 16, transform->t[1] - 160,
        transform->t[2] + forward_z / 16, 0 };
    SVECTOR velocity = { forward_x / 2, -1024, forward_z / 2, 0 };
    if (WebNetMatchActive())
        WebCheckpointArenaSelect(1);
    void* fireball = ObjectCreate("weaponFireball", 0, &position, &velocity);
    if (WebNetMatchActive())
        WebCheckpointArenaSelect(0);
    return (u32)fireball;
}

EMSCRIPTEN_KEEPALIVE s32 WebTestFireballCount(void)
{
    s32 count = 0;
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list)
        for (const Tm4ObjectHeader* header = ObjectLists[list].first; header; header = header->next)
            if (!strcmp(header->name, "weaponFireball"))
                ++count;
    return count;
}

void WebTestMotionInput(void)
{
    if (!EM_ASM_INT({ return !!tm4Port.testMotionSeed; }))
        return;
    /* Apply the same digital controls at the same game ticks in each fresh match. */
    u16* actions = GameInfo.players[0].bindings[0].actions;
    u16 buttons = 0, previous = 0;
    s32 tick = GetCurrentTime();
    if (tick >= 19 && tick < 90)
        buttons |= actions[GameControlGas];
    if (tick >= 20 && tick <= 90)
        previous |= actions[GameControlGas];
    if (tick >= 37 && tick < 70)
        buttons |= actions[GameControlSteerRight];
    if (tick >= 38 && tick <= 70)
        previous |= actions[GameControlSteerRight];
    if (tick >= 105 && tick < 109)
        buttons |= actions[GameControlLookBack];
    if (tick >= 106 && tick <= 109)
        previous |= actions[GameControlLookBack];
    PadCache* pad = &PadJpad[0];
    pad->buttons = buttons;
    pad->previous_buttons = previous;
    pad->pressed_buttons = buttons & ~previous;
    pad->released_buttons = previous & ~buttons;
    if (tick == 9)
        WebTestPlaceMotionPickups();
    if (tick == 28)
        WebTestSpawnMotionFireball();
    if (tick == 112 && GameInfo.players[0].car) {
        Car* car = GameInfo.players[0].car;
        MATRIX target = car->transform;
        target.t[1] -= 128;
        CarOrientWithMatrix(car, &target);
    }
}

EMSCRIPTEN_KEEPALIVE void WebTestReadCarModel(void)
{
    Car* car = GameInfo.players[0].car;
    if (!car)
        return;
    u32 uv_hash = 2166136261u;
    s32 count = 0;
    for (s32 i = 0; i < car->display_list_count; ++i)
        count += car->display_lists[i].face_count;
    for (s32 i = 0; i < count; ++i) {
        const u8* uv = (const u8*)&car->faces[i].texture;
        for (s32 j = 0; j < sizeof(car->faces[i].texture); ++j)
            uv_hash = (uv_hash ^ uv[j]) * 16777619u;
    }
    EM_ASM(
        {
            tm4Port.carModel = ({
                file : UTF8ToString($0),
                faces : $1,
                uvHash : $2 >>> 0,
                windupAngle : $3,
                leftWheel : $4,
                rightWheel : $5
            });
        },
        car->filename, count, uv_hash,
        !strcasecmp(car->filename, "toy") && car->callback_context ? *(s32*)car->callback_context
                                                                   : -1,
        car->wheels[3].rotation, car->wheels[2].rotation);
}

static int test_preview_angle = -1;

EMSCRIPTEN_KEEPALIVE void WebTestSetPreviewAngle(int angle)
{
    test_preview_angle = angle;
}

void WebTestDrawMenu(MenuGraphics* graphics)
{
    s32 original_angle = MenuPreviewRotationAngle;
    int preview_angle = test_preview_angle;
    if (preview_angle >= 0)
        MenuPreviewRotationAngle = preview_angle;
    MenuDrawScreen(graphics);
    if (preview_angle >= 0)
        MenuPreviewRotationAngle = original_angle;
    EM_ASM(
        {
            tm4Port.testPreviewAngle = $0;
            tm4Port.previewRotationAngle = $1;
        },
        preview_angle, MenuPreviewRotationAngle);
}
