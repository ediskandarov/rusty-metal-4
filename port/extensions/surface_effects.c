#include "surface_effects_runtime.h"
#include "port/psyz/sdk.h"
#include "tm4/fixed.h"
#include "tm4/main/object.h"
#include "tm4/main/os.h"
#include "tm4/main/registry.h"
#include "tm4/modules/car.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const Rm4SurfaceEffects* effects;

void WebSurfaceEffectsLoad(void)
{
    effects = NULL;
    char* name = RegGetFileDataS("/world/surfaceEffects");
    if (!name)
        return;
    const Rm4SurfaceEffects* candidate = (void*)OSSymbolGetAddress(name);
    if (!candidate || candidate->version != RM4_SURFACE_EFFECTS_VERSION
        || candidate->size != sizeof(*candidate)
        || (candidate->flags & ~RM4_SURFACE_REPLACE_CONTACT_AUDIO) || !candidate->instance_class
        || !*candidate->instance_class || !candidate->step || !candidate->reset) {
        fprintf(stderr, "Invalid surface effects provider: %s\n", name);
        abort();
    }
    effects = candidate;
}

void WebSurfaceEffectsUnload(void)
{
    effects = NULL;
}
int WebSurfaceEffectsOwnsAudio(const Car* car)
{
    return effects && car->surface_effects.instance
        && (effects->flags & RM4_SURFACE_REPLACE_CONTACT_AUDIO);
}

void WebSurfaceEffectsImpact(Car* car, int32_t speed)
{
    car->surface_effects.impact_speed = speed;
}

void WebSurfaceEffectsCompression(Car* car, unsigned wheel, int32_t compression)
{
    car->surface_effects.compression[wheel] = compression;
}

void WebSurfaceEffectsBegin(Car* car)
{
    memset(car->surface_effects.compression, 0, sizeof(car->surface_effects.compression));
    car->surface_effects.impact_speed = -1;
    car->surface_effects.discontinuous = 0;
}

int WebSurfaceEffectsAttach(Car* car)
{
    car->surface_effects = (Rm4SurfaceBinding) { 0 };
    WebSurfaceEffectsBegin(car);
    if (!effects)
        return 1;
    car->surface_effects.instance = ObjectCreate((char*)effects->instance_class,
        OBJECT_HAS_OWNER | OBJECT_DESTROY_WITH_OWNER | OBJECT_FOLLOW_OWNER, car);
    if (!car->surface_effects.instance) {
        fprintf(stderr, "Cannot create surface effects: %s\n", effects->instance_class);
        return 0;
    }
    if (ObjectGetHeader(car->surface_effects.instance)->process) {
        fprintf(stderr, "Surface effects class must not have a process callback: %s\n",
            effects->instance_class);
        WebSurfaceEffectsDetach(car);
        return 0;
    }
    return 1;
}

void WebSurfaceEffectsDetach(Car* car)
{
    void* instance = car->surface_effects.instance;
    car->surface_effects.instance = NULL;
    if (instance)
        ObjectDestroy(instance);
    car->surface_effects.contacts = 0;
    WebSurfaceEffectsBegin(car);
}

void WebSurfaceEffectsReset(Car* car)
{
    if (effects && car->surface_effects.instance)
        effects->reset(car->surface_effects.instance, Rm4SurfaceRelocated);
    car->surface_effects.contacts = 0;
    WebSurfaceEffectsBegin(car);
    car->surface_effects.discontinuous = 1;
}

void WebSurfaceEffectsStep(Car* car)
{
    if (!effects || !car->surface_effects.instance || car->surface_effects.discontinuous)
        return;
    Rm4SurfaceFrame frame = { 0 };
    frame.upright = car->transform.m[1][1] > 0;
    frame.impact_speed = car->surface_effects.impact_speed;
    for (unsigned i = 0; i < RM4_SURFACE_WHEELS; ++i) {
        const CarWheel* wheel = &car->wheels[i];
        const CarParticle* hit = wheel->response_particle;
        Rm4WheelContact* contact = &frame.wheels[i];
        contact->width = wheel->width;
        contact->compression = car->surface_effects.compression[i];
        if (!hit || !(hit->contact_state & 1))
            continue;
        contact->touching = 1;
        contact->material = hit->material;
        contact->slip_speed_q12 = hit->slip_speed_q12;
        contact->normal = hit->normal;
        contact->normal.pad = 0;
        contact->position = hit->position;
        if (wheel->group) {
            SVECTOR local = wheel->group->center.vector;
            local.vy += wheel->direction.fields.displacement + wheel->radius;
            ApplyMatrixSV(&car->transform, &local, &contact->position);
            contact->position.vx += car->transform.t[0];
            contact->position.vy += car->transform.t[1];
            contact->position.vz += car->transform.t[2];
        }
        contact->position.pad = 0;
        contact->movement.vx = hit->position.vx - hit->previous_position.vx;
        contact->movement.vy = hit->position.vy - hit->previous_position.vy;
        contact->movement.vz = hit->position.vz - hit->previous_position.vz;
        contact->velocity.vx = Q12Round(hit->velocity_q12.vx);
        contact->velocity.vy = Q12Round(hit->velocity_q12.vy);
        contact->velocity.vz = Q12Round(hit->velocity_q12.vz);
        frame.contacts |= 1u << i;
    }
    frame.began = frame.contacts & ~car->surface_effects.contacts;
    frame.ended = car->surface_effects.contacts & ~frame.contacts;
    frame.landed = !car->surface_effects.contacts && frame.contacts;
    car->surface_effects.contacts = frame.contacts;
    effects->step(car->surface_effects.instance, &frame);
}
