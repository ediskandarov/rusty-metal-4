#include "mouse_look.h"
#include "browser_report.h"
#include "interpolation.h"
#include "level.h"
#include "tm4/fixed.h"
#include "tm4/main/game.h"
#include "tm4/main/geometry.h"
#include "tm4/main/math3d.h"
#include "tm4/main/world.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/car.h"
#include <emscripten.h>
#include <math.h>
#include <stdint.h>

void WebMouseLookReset(void)
{
    EM_ASM({ globalThis.tm4MouseLook?.(false); });
}

static double visible_fraction(SVECTOR* pivot, SVECTOR* endpoint)
{
    Tm4WorldHit hit;
    if (!WebIntersectWorldTwoSided(pivot, endpoint, &hit))
        return 1;
    if (!hit.polygon)
        return 0;

    const double dx = endpoint->vx - pivot->vx;
    const double dy = endpoint->vy - pivot->vy;
    const double dz = endpoint->vz - pivot->vz;
    const double length_squared = dx * dx + dy * dy + dz * dz;
    const SVECTOR* normal = &hit.surface.vector;
    const double normal_travel = fabs(dx * normal->vx + dy * normal->vy + dz * normal->vz) / ONE;
    if (normal_travel <= 64)
        return 0;

    const double x = hit.position.vx / (double)ONE - pivot->vx;
    const double y = hit.position.vy / (double)ONE - pivot->vy;
    const double z = hit.position.vz / (double)ONE - pivot->vz;
    const double fraction = (x * dx + y * dy + z * dz) / length_squared;
    // Measure clearance perpendicular to the wall, including at grazing angles.
    return fmax(0, fraction - 64 / normal_travel);
}

#ifdef TM4_WEB_TEST_HOOKS
EMSCRIPTEN_KEEPALIVE double WebTestMouseLookFraction(
    int x, int y, int z, int end_x, int end_y, int end_z)
{
    SVECTOR pivot = { x, y, z, 0 };
    SVECTOR endpoint = { end_x, end_y, end_z, 0 };
    return visible_fraction(&pivot, &endpoint);
}
#endif

Camera* WebMouseLookCamera(const Tm4GamePlayer* player, Camera* camera, Camera* pose)
{
    const int available = WebLevelActive() && GameInfo.mode == GAME_MODE_PLAY
        && GameInfo.player_count == 1 && !GameInfo.pause_player && !GameInfo.next_mode
        && player->car && camera->object == player->car;
    const u32 angles = EM_ASM_INT({ return globalThis.tm4MouseLook?.(!!$0) ?? 0; }, available);
    if (!angles) {
#ifdef TM4_WEB_TEST_HOOKS
        WEB_BROWSER_REPORT(
            { tm4Port.mouseLook = ({ ready : !!$0, angle : 0, pitch : 0 }); }, available);
#endif
        return camera;
    }

    MATRIX car;
    WebInterpolationCarTransform(player->car, &car);
    // The model origin can sit below the road. Use the same center as the chase camera.
    SVECTOR pivot;
    ApplyMatrixWithTranslationSV(&car, &player->car->collision_box.center, &pivot);
    const s16 yaw = (s16)angles;
    const s16 pitch = (s16)(angles >> 16);
    MATRIX orbit = { .m = { { ONE, 0, 0 }, { 0, ONE, 0 }, { 0, 0, ONE } } };
    if (pitch) {
        // Tilt around the horizontal camera-right axis, then orbit around world up.
        SVECTOR right = { camera->camera_to_world.m[0][0], 0, camera->camera_to_world.m[2][0], 0 };
        if (VectorNormalSS(&right, &right))
            AxisAngleToRotMatrix(&right, pitch, &orbit);
    }
    RotMatrixY(yaw, &orbit);
    VECTOR offset = { camera->camera_to_world.t[0] - pivot.vx,
        camera->camera_to_world.t[1] - pivot.vy, camera->camera_to_world.t[2] - pivot.vz, 0 };
    ApplyMatrixLV(&orbit, &offset, &offset);

    const s32 x = pivot.vx + offset.vx;
    const s32 y = pivot.vy + offset.vy;
    const s32 z = pivot.vz + offset.vz;
    if (x < INT16_MIN || x > INT16_MAX || y < INT16_MIN || y > INT16_MAX
        || z < INT16_MIN || z > INT16_MAX)
        return camera;

    SVECTOR endpoint = { x, y, z, 0 };
    const double fraction = visible_fraction(&pivot, &endpoint);
    *pose = *camera;
    MulMatrix0(&orbit, &camera->camera_to_world, &pose->camera_to_world);
    pose->camera_to_world.t[0] = pivot.vx + lround(offset.vx * fraction);
    pose->camera_to_world.t[1] = pivot.vy + lround(offset.vy * fraction);
    pose->camera_to_world.t[2] = pivot.vz + lround(offset.vz * fraction);
    InverseMatrix(&pose->camera_to_world, &pose->world_to_camera);
#ifdef TM4_WEB_TEST_HOOKS
    WEB_BROWSER_REPORT(
        {
            tm4Port.mouseLook = ({
                ready : true, angle : $0, pitch : $1, fraction : $2,
                x : $3, y : $4, z : $5, forwardY : $6
            });
        },
        yaw, pitch, fraction, (s32)pose->camera_to_world.t[0],
        (s32)pose->camera_to_world.t[1], (s32)pose->camera_to_world.t[2],
        pose->camera_to_world.m[1][2]);
#endif
    return pose;
}
