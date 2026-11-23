/* Real production presentation offsets, with a synthetic game world. */
#include "port/web/rollback_visuals.h"
#include "tm4/main/game.h"
#include "tm4/main/object.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/car.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

Tm4GameInfo GameInfo;
static struct {
    Tm4ObjectHeader header;
    Car car;
} vehicle;
static struct {
    Tm4ObjectHeader header;
    Camera camera;
} view;

static void reset(void)
{
    memset(&GameInfo, 0, sizeof(GameInfo));
    memset(&vehicle, 0, sizeof(vehicle));
    memset(&view, 0, sizeof(view));
    vehicle.header.serial = 1;
    view.header.serial = 2;
    GameInfo.cars[0] = &vehicle.car;
    GameInfo.car_count = GameInfo.player_count = 1;
    GameInfo.players[0].camera = &view.camera;
    view.camera.object = &vehicle.car;
    vehicle.car.transform.t[0] = 100;
    view.camera.camera_to_world.t[0] = 60;
    WebRollbackVisualsReset();
}

static int position(double now)
{
    MATRIX draw = vehicle.car.transform;
    WebRollbackVisualsCar(&vehicle.car, &draw, now);
    return draw.t[0];
}

static void correct(double now, int dx)
{
    WebRollbackVisualsRemember(now);
    vehicle.car.transform.t[0] += dx;
    view.camera.camera_to_world.t[0] += dx;
    WebRollbackVisualsReconcile(now);
}

int main(void)
{
    reset();
    correct(1000, 40);
    Car live = vehicle.car;
    Camera camera = view.camera;
    assert(position(1000) == 100);
    assert(position(1050) == 120);
    assert(position(1100) == 140);
    MATRIX draw = view.camera.camera_to_world;
    assert(WebRollbackVisualsCamera(&view.camera, &draw, 1050));
    assert(draw.t[0] == 80);
    assert(memcmp(&live, &vehicle.car, sizeof(live)) == 0);
    assert(memcmp(&camera, &view.camera, sizeof(camera)) == 0);

    /* New movement remains immediate; only correction error decays. */
    vehicle.car.transform.t[0] += 10;
    assert(position(1050) == 130);
    correct(1050, 20);
    assert(position(1050) == 130);
    assert(position(1150) == 170);

    /* A replay with identical poses must not extend the smoothing interval. */
    reset();
    correct(1000, 40);
    correct(1050, 0);
    assert(position(1100) == 140);

    reset();
    correct(1000, 40);
    ++vehicle.header.serial;
    assert(position(1000) == 140);
    draw = view.camera.camera_to_world;
    assert(!WebRollbackVisualsCamera(&view.camera, &draw, 1000));

    reset();
    correct(1000, 40);
    WebRollbackVisualsCut(&vehicle.car);
    assert(position(1000) == 140);
    draw = view.camera.camera_to_world;
    assert(!WebRollbackVisualsCamera(&view.camera, &draw, 1000));

    reset();
    WebRollbackVisualsRemember(1000);
    WebRollbackVisualsCut(&vehicle.car);
    vehicle.car.transform.t[0] = 160;
    WebRollbackVisualsReconcile(1000);
    assert(position(1000) == 160);

    reset();
    correct(1000, 1000);
    assert(position(1000) == 1100);
    reset();
    correct(1000, 40);
    WebRollbackVisualsReset();
    assert(position(1000) == 140);
    puts("PASS rollback presentation continuity, decay, live input, identity, cuts and reset");
    return 0;
}
