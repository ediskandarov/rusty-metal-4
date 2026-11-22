# Car turbo presentation

A car's optional `turboEffect` directory references a shared MR profile:

```text
# Shared pack, for example TM3.MR
/resourcePacks/tm3/turbo/default/
    class = "tm3Turbo"
    sound = "turboLoop"
    sprite = 2
    size = 100
    fps = 12

# Car resource
turboEffect/
    profile = "/resourcePacks/tm3/turbo/default"
    position = [0, 0, 0]  # optional type 26 SVECTOR in car-local coordinates
```

The port interprets only `profile`, `position` and the profile's `class`.
All other profile entries belong to that class. Texture, geometry, particles,
light and sound are optional choices of the implementation, not engine requirements.
The TM3 profile currently keeps the existing TM4 turbo loop; its original TM3
sample has not been identified.

## Connection and ownership

1. Car resource preparation resolves the absolute profile path and mount. A missing
   `turboEffect` preserves TM4 presentation. An explicit invalid binding fails preparation.
2. After the car constructor succeeds, the port creates the named registered class
   with the car as owner and `OBJECT_DESTROY_WITH_OWNER`.
3. The packed constructor receives a borrowed `Rm4TurboAppearanceContext` from
   [turbo.h](../../port/extensions/turbo.h). Copy needed settings; do not retain the context.
4. Normal object-list ordering processes the effect after its owner. Read
   `Car.turbo_thrust_applied`, set by successful physics application each tick.
   Input intent and remaining fuel are insufficient: the final 20 fuel units buy
   one boost even though the remaining fuel is zero.
5. The effect transforms its local mount through the car matrix and positions its
   own objects. It is not automatically repositioned by `OBJECT_FOLLOW_OWNER`.

With a custom profile, the stock flame, light and turbo loop are suppressed together.
Fuel, acceleration, controller vibration and extinguishing remain engine mechanics.
The class must be registered before car creation and use the default object list;
reserved engine-list classes cannot be used for this attachment.

## Rollback and unloading

Register a normal [snapshot schema](mod-objects.md) for the effect. Copy scalar
profile settings, serialize object references using snapshot fields, and rebind
immutable resources by name/template as appropriate. Never serialize raw profile
pointers. An effect created at tick zero and removed with its car must allow
baseline removal. Car profile pointers and mounts are rebound from car resources.

Use soundEmitter objects and the engine audio lifecycle. Own sounds/children with
`OBJECT_DESTROY_WITH_OWNER`; fade or stop loops when thrust ends. Replaying simulation
recreates effects; restoring snapshots must not replay activation sounds. Cosmetic
randomness must use the effect random stream. Classes and resources must remain loaded
until all instances and their snapshot users are gone.

Checks: `tm4_turbo_check` tests binding validation and fallback. The TM3 mod's
`tests/browser/check_tm3_turbo.mjs` exercises fuel boundaries, single-loop ownership,
local rollback, portable restore and car removal in a live simulation.
