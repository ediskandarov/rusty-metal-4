#ifndef RM4_SURFACE_EFFECTS_H
#define RM4_SURFACE_EFFECTS_H

#include <libgte.h>
#include <stdint.h>

enum { RM4_SURFACE_WHEELS = 4,
    RM4_SURFACE_EFFECTS_VERSION = 2 };

/* Positions, displacement, widths and compression use world units. Normals and
   slip speed use Q12. Velocity is displacement per simulation tick (30 Hz).
   A non-contact wheel still reports its width and suspension compression. */
typedef struct {
    SVECTOR position, normal, movement;
    VECTOR velocity;
    int32_t material, width, compression, slip_speed_q12;
    uint32_t touching;
} Rm4WheelContact;

typedef struct {
    Rm4WheelContact wheels[RM4_SURFACE_WHEELS];
    uint32_t contacts, began, ended, landed, upright;
    /* -1 means no contact-impact event; zero is a valid impact speed. */
    int32_t impact_speed;
} Rm4SurfaceFrame;

typedef enum { Rm4SurfaceRelocated } Rm4SurfaceReset;

/* Without this flag, the engine keeps its impact and suspension landing sounds.
   Skid sounds and other provider effects are independent of this choice. */
enum { RM4_SURFACE_REPLACE_CONTACT_AUDIO = 1u << 0 };

/* Exported immutable descriptor named by world/surfaceEffects. Callbacks run
   on simulation ticks, including replay, and may create effect objects only.
   The instance is an ordinary object owned by the car, with a NULL process
   callback. Its snapshot schema belongs to the module. Frame pointers are
   borrowed for the duration of step; do not retain them. */
typedef struct {
    uint32_t version, size, flags;
    const char* instance_class;
    void (*step)(void* instance, const Rm4SurfaceFrame* frame);
    void (*reset)(void* instance, Rm4SurfaceReset reason);
} Rm4SurfaceEffects;

#endif
