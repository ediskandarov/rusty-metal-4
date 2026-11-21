#include "port/extensions/teleport_runtime.h"
#include "port/web/module_import.h"
#include "src/modules/tele/private.h"
#include "tm4/main/game.h"
#include "tm4/main/object.h"
#include "tm4/main/registry.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/car.h"
#include <assert.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

Tm4GameInfo GameInfo;
static int provider_present, file_type = REG_FILE_TYPE_STRING, online, occupied;
static int moves, notices, arrivals, sounds;
static const char* appearance;
static Rm4TeleportEvent captured;
static int visual_creations, visual_fail;
static void* visual_owner;
static Rm4TeleportAppearanceContext visual_context;
static void orient(Car* car, MATRIX* matrix)
{
    ++moves;
    car->transform = *matrix;
    car->position = (SVECTOR) { matrix->t[0], matrix->t[1], matrix->t[2], 0 };
}
static void ai(void* car)
{
    assert(car);
    ++notices;
}
static void arrived(const Rm4TeleportEvent* event)
{
    assert(notices == moves); /* Notification follows the complete relocation. */
    captured = *event;
    ++arrivals;
}
static Rm4TeleportEffects provider = {
    .version = RM4_TELEPORT_EFFECTS_VERSION,
    .size = sizeof(Rm4TeleportEffects),
    .arrived = arrived,
};
OSWord WebResolveModuleImport(WebModuleImport* binding)
{
    assert(!strcmp(binding->module, "car"));
    if (!strcmp(binding->symbol, "CarOrientWithMatrix"))
        return (OSWord)orient;
    assert(!strcmp(binding->symbol, "CarAiMovedThroughTeleporter"));
    return (OSWord)ai;
}
RegistryFile* RegGetFilePtrS(char* path)
{
    assert(!strcmp(path, "/world/teleportEffects"));
    return provider_present ? (RegistryFile*)1 : NULL;
}
RegistryFile* RegGetFilePtrPS(RegistryDirectory* directory, char* path)
{
    assert(!strcmp(path, "appearance"));
    return appearance ? (RegistryFile*)2 : NULL;
}
s32 RegGetFileTypeP(const RegistryFile* file)
{
    return file_type;
}
void* RegGetFileDataP(RegistryFile* file)
{
    return file == (RegistryFile*)1 ? "testTeleport" : (void*)appearance;
}
OSWord OSSymbolGetAddress(char* name)
{
    assert(!strcmp(name, "testTeleport"));
    return (OSWord)&provider;
}
int WebNetMatchActive(void)
{
    return online;
}
int WebNetSlotOccupied(int slot)
{
    assert(slot >= 0 && slot < 8);
    return occupied;
}
void* ObjectCreate(char* name, u32 flags, ...)
{
    if (!strcmp(name, "testPortalVisual")) {
        assert(flags == (OBJECT_HAS_OWNER | OBJECT_DESTROY_WITH_OWNER | OBJECT_FOLLOW_OWNER));
        va_list args;
        va_start(args, flags);
        visual_owner = va_arg(args, void*);
        visual_context = *va_arg(args, const Rm4TeleportAppearanceContext*);
        va_end(args);
        ++visual_creations;
        return visual_fail ? NULL : &visual_context;
    }
    if (!strcmp(name, "unknown"))
        return NULL;
    assert(!strcmp(name, "soundEmitter") && flags == 0);
    ++sounds;
    return NULL;
}

void TeleporterClassConstructor(RegistryDirectory*);
s32 TeleporterInstanceConstructor(Teleporter*, RegistryDirectory*);
static SVECTOR entrance = { 11, 22, 33, 0 };
static SVECTOR destination[2] = { { 100, 200, 300, 0 }, { 0, 0, 4096, 0 } };
static u32 constructed_radius;
void* RegGetFileDataS(char* path)
{
    return NULL;
} /* No portal textures. */
void* RegGetFileDataPS(RegistryDirectory* directory, char* path)
{
    if (!strcmp(path, "pos"))
        return &entrance;
    if (!strcmp(path, "dest"))
        return destination;
    return NULL;
}
void ObjectSetPosition(void* payload, u32 x, u32 y, u32 z)
{
    assert(x == 11 && y == 22 && z == 33);
}
void ObjectSetInteractionRadius(void* payload, u32 radius)
{
    constructed_radius = radius;
}

int main(int argc, char** argv)
{
    if (argc > 1) {
        provider_present = 1;
        if (!strcmp(argv[1], "version"))
            provider.version--;
        else if (!strcmp(argv[1], "size"))
            provider.size--;
        else if (!strcmp(argv[1], "flags"))
            provider.flags = 0x80000000;
        else if (!strcmp(argv[1], "callback"))
            provider.arrived = NULL;
        else if (!strcmp(argv[1], "type"))
            file_type = REG_FILE_TYPE_LONG;
        else
            abort();
        WebTeleportLoad();
        return 0;
    }
    const char* custom = "unused";
    assert(WebTeleportAppearance(NULL, &custom) == 1 && !custom);
    appearance = "none";
    assert(WebTeleportAppearance(NULL, &custom) == 0);
    appearance = "original";
    assert(WebTeleportAppearance(NULL, &custom) == 1);
    appearance = "";
    assert(WebTeleportAppearance(NULL, &custom) == -1);
    appearance = "none";
    file_type = REG_FILE_TYPE_LONG;
    assert(WebTeleportAppearance(NULL, &custom) == -1);
    file_type = REG_FILE_TYPE_STRING;
    Teleporter portal = { 0 };
    TeleporterClassConstructor(NULL);
    assert(TeleTextureCount == 0 && TeleDefaultRadius == 300);
    assert(TeleColorDefault == &TeleDefaultColor);
    assert(TeleporterInstanceConstructor(&portal, NULL));
    assert(!portal.render_portal && portal.color && constructed_radius == 300);
    assert(portal.destination_world.vx == 100 && portal.destination_forward_world.vz == 4096);
    appearance = "testPortalVisual";
    assert(TeleporterInstanceConstructor(&portal, NULL) && !portal.render_portal);
    assert(visual_creations == 1 && visual_owner == &portal);
    assert(visual_context.position.vx == 11 && visual_context.destination.vx == 100
        && visual_context.forward.vz == 4096 && visual_context.radius == 300);
    visual_fail = 1;
    assert(!TeleporterInstanceConstructor(&portal, NULL));
    visual_fail = 0;
    int created = visual_creations;
    appearance = "unknown";
    assert(!TeleporterInstanceConstructor(&portal, NULL));
    appearance = "";
    assert(!TeleporterInstanceConstructor(&portal, NULL));
    assert(created == visual_creations);
    appearance = "original";
    assert(!TeleporterInstanceConstructor(&portal, NULL)); /* Visible portal needs textures. */
    TeleTextureCount = 1;
    assert(TeleporterInstanceConstructor(&portal, NULL) && portal.render_portal);

    Car car = { 0 };
    car.controller_index = -1; /* A bot must never index players[-1]. */
    car.transform.t[0] = 90;
    WebTeleportLoad();
    Rm4TeleportRequest request = {
        .destination = { 100, 200, 300, 0 },
        .forward = { 0, 0, 4096, 0 },
        .source = &car,
    };
    Car before = car;
    Rm4TeleportRequest invalid = request;
    invalid.forward.vz = 0;
    assert(!WebTeleportCar(&car, &invalid));
    assert(!WebTeleportCar(NULL, &request));
    assert(!WebTeleportCar(&car, NULL));
    assert(!memcmp(&car, &before, sizeof(car)) && !moves && !sounds);
    assert(WebTeleportCar(&car, &request));
    assert(moves == 1 && notices == 1 && sounds == 2 && !arrivals);
    assert(car.transform.t[0] == 100 && car.transform.t[1] == 200 && car.transform.t[2] == 300);
    assert(car.transform.m[0][0] == 4096 && car.transform.m[1][1] == 4096
        && car.transform.m[2][2] == 4096);

    provider_present = 1;
    WebTeleportLoad();
    request.destination.vx = 400;
    assert(WebTeleportCar(&car, &request));
    assert(arrivals == 1 && sounds == 4); /* Custom particles can retain stock sound. */
    assert(captured.before.t[0] == 100 && captured.after.t[0] == 400);
    assert(captured.car == &car && captured.source == &car);
    provider.flags = RM4_TELEPORT_REPLACE_AUDIO;
    request.source = NULL;
    request.destination.vx = 500;
    car.controller_index = 7;
    CarCameraState state = { 0 };
    Camera camera = { .object = &car, .data = &state };
    GameInfo.players[7].camera = &camera;
    online = occupied = 1;
    assert(WebTeleportCar(&car, &request));
    assert(state.snap == 1 && sounds == 4 && arrivals == 2 && !captured.source);
    state.snap = 0;
    occupied = 0;
    assert(WebTeleportCar(&car, &request) && !state.snap);
    GameInfo.players[7].camera = NULL;
    occupied = 1;
    assert(WebTeleportCar(&car, &request));
    car.controller_index = 99;
    assert(WebTeleportCar(&car, &request));
    WebTeleportUnload();
    int previous_arrivals = arrivals;
    assert(WebTeleportCar(&car, &request));
    assert(arrivals == previous_arrivals && sounds == 6);
    puts(
        "PASS: teleport validation, appearance, event positions, optional audio, bots and camera ownership");
    return 0;
}
