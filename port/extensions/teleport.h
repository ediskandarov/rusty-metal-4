#ifndef RM4_TELEPORT_H
#define RM4_TELEPORT_H

#include <libgte.h>
#include <stdint.h>

struct Car;
struct RegistryDirectory;
enum { RM4_TELEPORT_EFFECTS_VERSION = 1 };
enum { RM4_TELEPORT_REPLACE_AUDIO = 1u << 0 };

/* Constructor-only borrowed context. Copy needed values into the visual object;
   do not retain this pointer. The engine supplies the portal as object owner. */
typedef struct {
    struct RegistryDirectory* registry;
    SVECTOR position, destination, forward;
    uint32_t radius;
} Rm4TeleportAppearanceContext;

typedef struct {
    SVECTOR destination;
    /* World-space forward direction, Q12. Must have a horizontal component. */
    SVECTOR forward;
    const void* source;
} Rm4TeleportRequest;

typedef struct {
    struct Car* car;
    const void* source;
    MATRIX before, after;
} Rm4TeleportEvent;

/* Immutable descriptor exported by world/teleportEffects. Called synchronously
   after a successful move, also during replay. Only create presentation objects;
   do not move/destroy the car or retain the event. Objects need snapshot schemas,
   and sounds must use the engine audio lifecycle. No callback on snapshot restore. */
typedef struct {
    uint32_t version, size, flags;
    void (*arrived)(const Rm4TeleportEvent* event);
} Rm4TeleportEffects;

/* Existing TM4 relocation semantics: clear velocities, cut interpolation and
   surface history, snap the controlling camera and notify AI. Invalid requests
   return zero before changing anything. The source object is optional/borrowed. */
int WebTeleportCar(struct Car* car, const Rm4TeleportRequest* request);

#endif
