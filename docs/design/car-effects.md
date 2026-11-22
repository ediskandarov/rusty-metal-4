# Car effect profiles

A car may independently reference `freezeEffect/profile` and
`invisibilityEffect/profile`, each an absolute path to an MR directory. No binding
means stock TM4 presentation for that effect. An explicit malformed binding fails
car preparation; it does not silently select the stock renderer.

```text
car/
  freezeEffect/profile = /resourcePacks/example/effects/ice
  invisibilityEffect/profile = /resourcePacks/example/effects/cloak

resourcePacks/example/effects/
  ice/
    drawBody = ExampleDrawBody
    drawOverlay = ExampleDrawIce
    minimumLight = 32
  cloak/
    drawBody = ExampleDrawCloakedBody
    minimumLight = 32
    sound = exampleCloakLoop
```

The callbacks use `Rm4CarEffectDraw` from
[`car_effects.h`](../../port/extensions/car_effects.h), not a descriptor symbol.
Freeze accepts a body replacement, an overlay, or both. Invisibility requires a
body callback and has no overlay: it customizes the owner's view only. Other
cameras see no invisible body; a simultaneous freeze overlay remains visible.
The port supplies projected, culled faces and a bounded packet slice. Callbacks
must stay within it and cannot mutate gameplay state, advance RNG, create objects
or retain pointers. Any untextured blend state must be bracketed by local draw-mode
packets. Ordering-table insertion is LIFO: the port emits the overlay before the
body so the overlay is drawn last.

The shield keeps its stock implementation. Freeze, invisibility and shield retain
separate timers and sound references. A configured profile without `sound` is
silent; a supplied sound must already be loaded and looping. `minimumLight`
defaults to 64 (range 0–140); while frozen, the freeze setting takes precedence.
Ending one effect must not release mesh copies still used by another.

## Mechanics remain separate

Effect durations stay in TM4's stock mechanics: freeze lasts 120 ticks;
invisibility and shield last 180 ticks each. Appearance profiles cannot change
these durations. Mod projectiles call `CarFreezeCar` without rewriting its timer.

`freezeAttack/profile` separately names a `launchFunc` with the existing
`CarWeaponLaunch` signature. Absence retains the stock launcher. This binding
selects the attack implementation, not frozen-car appearance.

Profiles and callbacks are immutable resources rebound by `CarPrepareResources`
on snapshot restoration. They are `SNAP_LOCAL`; timers, sound-object references
and stock mesh copies keep their existing snapshot fields. A stateless draw
callback needs no additional simulation object or snapshot schema.

## Checks

```sh
cmake --build build/diagnostic --target tm4_car_effects_check
node build/diagnostic/tm4_car_effects_check.cjs
```

The TM3 mod's `check_tm3_freeze.mjs --effects both|freeze|invisibility|stock`
exercises the profile combinations through controller input, including shield,
local rollback and portable restore.
