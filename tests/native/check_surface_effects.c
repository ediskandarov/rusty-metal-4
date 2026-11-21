/* Registry/object fixtures drive the production adapter; GTE uses PsyZ. */
#include "port/extensions/surface_effects_state.h"
#include "port/web/net_state_fields.h"
#include "tm4/main/os.h"
#include "tm4/modules/car.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static struct {
    Tm4ObjectHeader header;
    int payload;
} objects[4];
static unsigned created, destroyed, steps, resets;
static int enabled, fail_create, independent_process;
static Rm4SurfaceFrame frame;
static void* stepped;

static void step(void* instance, const Rm4SurfaceFrame* input)
{
    ++steps;
    stepped = instance;
    frame = *input;
}
static void reset(void* instance, Rm4SurfaceReset reason)
{
    assert(instance && reason == Rm4SurfaceRelocated);
    ++resets;
}
static void process(void* instance) { abort(); }
static Rm4SurfaceEffects provider = {
    .version = RM4_SURFACE_EFFECTS_VERSION,
    .size = sizeof(Rm4SurfaceEffects),
    .instance_class = "testSurface",
    .step = step,
    .reset = reset,
};
void* RegGetFileDataS(char* path)
{
    assert(!strcmp(path, "/world/surfaceEffects"));
    return enabled ? "TestSurface" : NULL;
}
OSWord OSSymbolGetAddress(char* name)
{
    assert(!strcmp(name, "TestSurface"));
    return (OSWord)&provider;
}
void* ObjectCreate(char* name, u32 flags, ...)
{
    assert(!strcmp(name, "testSurface"));
    assert(flags == (OBJECT_HAS_OWNER | OBJECT_DESTROY_WITH_OWNER | OBJECT_FOLLOW_OWNER));
    if (fail_create)
        return NULL;
    assert(created < ArrayCount(objects));
    Tm4ObjectHeader* header = &objects[created].header;
    header->serial = created++;
    header->process = independent_process ? process : NULL;
    va_list args;
    va_start(args, flags);
    header->owner = va_arg(args, Car*);
    va_end(args);
    assert(header->owner);
    return ObjectGetPayload(header);
}
void ObjectDestroy(void* instance)
{
    assert(instance);
    ++destroyed;
}
s32 ObjectValidObject(void* instance) { return instance != NULL; }

static u32 digest(const Car* car)
{
    u32 hash = 2166136261u;
    NetStateOutput output = { .checksum = &hash };
    WebSurfaceEffectsWriteState(&output, &car->surface_effects);
    return hash;
}

int main(int argc, char** argv)
{
    enabled = 1;
    if (argc > 1) {
        if (!strcmp(argv[1], "version"))
            provider.version--;
        else if (!strcmp(argv[1], "size"))
            provider.size--;
        else if (!strcmp(argv[1], "flags"))
            provider.flags = 0x80000000;
        else if (!strcmp(argv[1], "step"))
            provider.step = NULL;
        else if (!strcmp(argv[1], "reset"))
            provider.reset = NULL;
        else
            abort();
        WebSurfaceEffectsLoad();
        return 0; /* The runner requires rejection before reaching here. */
    }
    Car car = { 0 }, other = { 0 };
    enabled = 0;
    WebSurfaceEffectsLoad();
    assert(WebSurfaceEffectsAttach(&car));
    assert(!WebSurfaceEffectsOwnsAudio(&car));
    WebSurfaceEffectsBegin(&car);
    WebSurfaceEffectsStep(&car);
    WebSurfaceEffectsReset(&car);
    WebSurfaceEffectsDetach(&car);
    assert(created == 0 && steps == 0 && resets == 0 && destroyed == 0);

    enabled = 1;
    WebSurfaceEffectsLoad();
    fail_create = 1;
    assert(!WebSurfaceEffectsAttach(&car));
    assert(!WebSurfaceEffectsOwnsAudio(&car));
    fail_create = 0;
    independent_process = 1;
    assert(!WebSurfaceEffectsAttach(&car));
    assert(!car.surface_effects.instance && destroyed == 1);
    independent_process = 0;
    assert(WebSurfaceEffectsAttach(&car) && WebSurfaceEffectsAttach(&other));
    assert(ObjectGetHeader(car.surface_effects.instance)->owner == &car);
    assert(!WebSurfaceEffectsOwnsAudio(&car)); /* Visual-only provider keeps TM4 audio. */
    provider.flags = RM4_SURFACE_REPLACE_CONTACT_AUDIO;
    assert(WebSurfaceEffectsOwnsAudio(&car) && WebSurfaceEffectsOwnsAudio(&other));

    CarParticle hit = { 0 };
    car.wheels[3].response_particle = &hit;
    car.wheels[3].width = 80;
    car.transform.m[1][1] = 4096;
    hit.contact_state = 1;
    hit.position = (SVECTOR) { 100, 200, 300, 123 };
    hit.previous_position = (SVECTOR) { 90, 220, 270, 0 };
    hit.normal = (SVECTOR) { 0, -4096, 0, 456 };
    hit.velocity_q12 = (Tm4VectorXYZ) { 2 * 4096, -3 * 4096, 4 * 4096 };
    hit.material = 7;
    hit.slip_speed_q12 = 0x800000;
    CarParticle before_hit = hit;
    MATRIX before_transform = car.transform;
    WebSurfaceEffectsBegin(&car);
    WebSurfaceEffectsImpact(&car, 0); /* Zero impact differs from no event. */
    WebSurfaceEffectsCompression(&car, 3, 29);
    WebSurfaceEffectsStep(&car);
    assert(steps == 1 && stepped == car.surface_effects.instance);
    assert(frame.contacts == 8 && frame.began == 8 && frame.ended == 0 && frame.landed);
    assert(frame.upright && frame.impact_speed == 0);
    const Rm4WheelContact* wheel = &frame.wheels[3];
    assert(wheel->compression == 29 && wheel->width == 80 && wheel->material == 7);
    assert(wheel->movement.vx == 10 && wheel->movement.vy == -20 && wheel->movement.vz == 30);
    assert(wheel->velocity.vx == 2 && wheel->velocity.vy == -3 && wheel->velocity.vz == 4);
    assert(wheel->position.pad == 0 && wheel->normal.pad == 0);
    assert(!memcmp(&hit, &before_hit, sizeof(hit)));
    assert(!memcmp(&car.transform, &before_transform, sizeof(before_transform)));
    assert(other.surface_effects.contacts == 0);

    u32 captured = digest(&car);
    WebSurfaceEffectsBegin(&car);
    assert(digest(&car) == captured); /* Scratch never enters the canonical state. */
    WebSurfaceEffectsStep(&car);
    assert(!frame.began && !frame.ended && !frame.landed && frame.impact_speed == -1);
    assert(frame.wheels[3].compression == 0);
    hit.contact_state = 0;
    WebSurfaceEffectsStep(&car);
    assert(frame.contacts == 0 && frame.ended == 8 && !frame.landed);
    assert(digest(&car) != captured);

    hit.contact_state = 1;
    WebSurfaceEffectsReset(&car);
    unsigned previous_steps = steps;
    WebSurfaceEffectsStep(&car);
    assert(resets == 1 && steps == previous_steps); /* Discard stale pre-teleport contacts. */
    WebSurfaceEffectsBegin(&car);
    WebSurfaceEffectsStep(&car);
    assert(frame.began == 8 && frame.landed && frame.impact_speed == -1);
    WebSurfaceEffectsDetach(&car);
    assert(!WebSurfaceEffectsOwnsAudio(&car) && WebSurfaceEffectsOwnsAudio(&other));
    WebSurfaceEffectsDetach(&car);
    assert(destroyed == 2); /* Partial construction/destruction can clean up twice. */
    WebSurfaceEffectsDetach(&other);
    WebSurfaceEffectsUnload();
    assert(destroyed == 3 && !WebSurfaceEffectsOwnsAudio(&other));
    puts("PASS: surface lifecycle, audio opt-in, contact transitions, relocation and canonical state");
    return 0;
}
