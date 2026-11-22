#include "port/extensions/car_attacks.h"
#include "port/extensions/car_effects_runtime.h"
#include "tm4/main/game.h"
#include "tm4/main/object.h"
#include "tm4/main/os.h"
#include "tm4/modules/camera.h"
#include "tm4/modules/car_weapon.h"
#include <assert.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

struct RegistryDirectory {
    int index, binding;
};
struct RegistryFile {
    int type;
    u32 bytes;
    int count;
    void* data;
};
static RegistryDirectory bindings[] = { { 0, 1 }, { 1, 1 }, { 2, 1 } };
static RegistryDirectory profiles[] = { { 0, 0 }, { 1, 0 }, { 2, 0 } };
static char* names[] = { "freezeEffect", "invisibilityEffect", "freezeAttack" };
static char paths[][24] = { "/effects/freeze", "/effects/invisibility", "/attack" };
static RegistryFile references[3];
static char body_name[] = "body", overlay_name[] = "overlay", launch_name[] = "launch";
static char loop_name[] = "loop";
static s32 minimum = 32;
static RegistryFile body = { 2, sizeof(body_name), 1, body_name };
static RegistryFile overlay = { 2, sizeof(overlay_name), 1, overlay_name };
static RegistryFile launcher = { 2, sizeof(launch_name), 1, launch_name };
static RegistryFile sound = { 2, sizeof(loop_name), 1, loop_name };
static RegistryFile light = { 4, sizeof(minimum), 1, &minimum };
static unsigned enabled, wrong_binding, with_sound, with_overlay = 1;
static int wrong_symbol, loop_valid = 1, body_calls, overlay_calls, creations;
static RegistryDirectory* last_profile;
Tm4GameInfo GameInfo;

RegistryDirectory* RegGetDirectoryPtrS(char* name)
{
    for (int i = 0; i < 3; ++i) {
        if (!strcmp(name, names[i]))
            return enabled & (1u << i) ? &bindings[i] : NULL;
        if (!strcmp(name, paths[i]))
            return &profiles[i];
    }
    return NULL;
}
RegistryDirectory* RegGetDirectoryPtrPS(RegistryDirectory* directory, char* name)
{
    (void)directory;
    (void)name;
    return NULL;
}
RegistryFile* RegGetFilePtrS(char* name)
{
    return wrong_binding && !strcmp(name, names[0]) ? &body : NULL;
}
RegistryFile* RegGetFilePtrPS(RegistryDirectory* directory, char* name)
{
    if (directory->binding)
        return !strcmp(name, "profile") ? &references[directory->index] : NULL;
    int i = directory->index;
    if (i < 2) {
        if (!strcmp(name, "drawBody"))
            return &body;
        if (!strcmp(name, "drawOverlay") && (with_overlay & (1u << i)))
            return &overlay;
        if (!strcmp(name, "minimumLight"))
            return &light;
        if (!strcmp(name, "sound") && (with_sound & (1u << i)))
            return &sound;
    }
    if (i == 2 && !strcmp(name, "launchFunc"))
        return &launcher;
    return NULL;
}
s32 RegGetFileTypeP(const RegistryFile* file)
{
    return file->type;
}
u32 RegGetFileByteSizeP(const RegistryFile* file)
{
    return file->bytes;
}
s32 RegGetFileArraySizeP(const RegistryFile* file)
{
    return file->count;
}
void* RegGetFileDataP(RegistryFile* file)
{
    return file->data;
}
static void draw_body(RegistryDirectory* profile, const Rm4CarEffectFace* face)
{
    assert(face);
    ++body_calls;
    last_profile = profile;
}
static void draw_overlay(RegistryDirectory* profile, const Rm4CarEffectFace* face)
{
    assert(face && profile == &profiles[0]);
    ++overlay_calls;
}
static s32 launch(Car* car, void* target, CarWeaponInstance* weapon, s32 rear)
{
    (void)car;
    (void)target;
    (void)weapon;
    return rear + 1;
}
OSWord OSSymbolGetAddress(char* name)
{
    if (wrong_symbol)
        return 0;
    if (!strcmp(name, "body"))
        return (OSWord)draw_body;
    if (!strcmp(name, "overlay"))
        return (OSWord)draw_overlay;
    if (!strcmp(name, "launch"))
        return (OSWord)launch;
    return 0;
}
s32 SoundIsLooping(char* name)
{
    assert(!strcmp(name, "loop"));
    return loop_valid;
}
const Car* WebInterpolationCarIdentity(const Car* car)
{
    return car;
}
void* ObjectCreate(char* name, u32 flags, ...)
{
    assert(!strcmp(name, "soundEmitter"));
    assert(flags == (OBJECT_HAS_OWNER | OBJECT_DESTROY_WITH_OWNER | OBJECT_FOLLOW_OWNER));
    ++creations;
    return &creations;
}

int main(void)
{
    for (int i = 0; i < 3; ++i)
        references[i] = (RegistryFile) { 2, strlen(paths[i]) + 1, 1, paths[i] };
    Car car = { 0 };
    car.character_name = "test";
    Camera camera = { 0 };
    GameInfo.active_view = &camera;
    camera.object = &car;
    Rm4CarEffectFace face = { .car = &car };
    assert(WebCarEffectsLoad(&car) && WebCarAttacksLoad(&car));
    assert(!car.freeze_effect.resource && !car.invisibility_effect.resource && !car.freeze_launch);
    assert(!WebCarEffectBody(&car, &face));
    for (enabled = 1; enabled <= 3; ++enabled) {
        assert(WebCarEffectsLoad(&car));
        car.freeze_ticks = car.invisibility_ticks = 1;
        assert(WebCarEffectsMinimumLight(&car) == ((enabled & 1) ? 32 : 64));
        assert(WebCarEffectBody(&car, &face));
        assert(last_profile == &profiles[(enabled & 2) ? 1 : 0]);
        int prior = body_calls;
        camera.object = NULL;
        assert(WebCarEffectBody(&car, &face));
        assert(body_calls == prior + !(enabled & 2));
        prior = overlay_calls;
        WebCarEffectOverlay(&car, &face);
        assert(overlay_calls == prior + !!(enabled & 1));
        camera.object = &car;
    }
    enabled = 7;
    with_sound = 1;
    assert(WebCarEffectsLoad(&car) && WebCarAttacksLoad(&car));
    assert(car.freeze_launch(&car, NULL, NULL, 1) == 2);
    WebCarEffectLoop(&car, RM4_CAR_FREEZE);
    WebCarEffectLoop(&car, RM4_CAR_FREEZE);
    WebCarEffectLoop(&car, RM4_CAR_INVISIBILITY);
    assert(creations == 1 && car.freeze_sound && !car.invisibility_sound);
    wrong_binding = 1;
    assert(!WebCarEffectsLoad(&car));
    wrong_binding = 0;
    references[0].type = 4;
    assert(!WebCarEffectsLoad(&car));
    references[0].type = 2;
    references[0].bytes--;
    assert(!WebCarEffectsLoad(&car));
    references[0].bytes++;
    minimum = 141;
    assert(!WebCarEffectsLoad(&car));
    minimum = 32;
    wrong_symbol = 1;
    assert(!WebCarEffectsLoad(&car));
    assert(!WebCarAttacksLoad(&car));
    wrong_symbol = 0;
    with_overlay = 3;
    assert(!WebCarEffectsLoad(&car));
    with_overlay = 1;
    loop_valid = 0;
    assert(!WebCarEffectsLoad(&car));
    loop_valid = 1;
    assert(WebCarEffectsLoad(&car) && WebCarAttacksLoad(&car));
    puts("PASS car profile validation, independent appearance, visibility, sounds and mechanics");
    return 0;
}
