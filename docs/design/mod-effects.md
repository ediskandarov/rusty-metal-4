# Mod effects and resource ownership

MR stores resources and symbolic bindings. Mods own their gameplay objects and
effects; the port supplies shared lifecycle, rendering and snapshot integration.
The contracts linked below describe implemented interfaces.

## Implemented map interfaces

| Area | Contract | Responsibility |
| --- | --- | --- |
| Weapons | [Weapon profiles](weapon-profiles.md) | Named profiles and a per-map arsenal; modules own launchers and projectile behaviour. |
| Surface effects | [Surface effects](surface-effects.md) | The engine reports wheel contacts; the map provider supplies particles and tyre marks. Surface physics remains separate. |
| Teleports | [Teleports](teleport.md) | The engine owns traversal; modules supply arrival/departure effects and optional portal classes. |
| Fragment impacts | [Fragment effects](fragment-effects.md) | The engine reports impacts; the provider creates presentation effects without changing simulation randomness. |
| Objects and screen effects | [Object lifecycle](mod-objects.md) | Mods register ordinary classes, interactions and snapshot descriptions; screen callbacks emit drawing packets only. |
| Background and startpoints | [Map settings](map-settings.md) | Maps provide background colour and complete spawn coordinates. Renderer budgets remain engine-owned. |
| Texture storage | [Texture banks](texture-banks.md) | The port manages texture allocation; mods supply ordinary resources. |
| Sound storage | [Sound banks](sound-banks.md) | The port manages sample banks; mods supply VAB resources. |

Map weapons use `/weaponProfiles` and `/world/arsenal`. The original disc weapon
list is an adapter for stock resources, not the extension interface for new weapons.
Car specials retain their own behaviour and lifecycle.

Staged destruction belongs to mod classes. The engine provides collision owners,
geometry toggles, navigation updates and object creation. Stage directories such
as `next`, `passive` and `onDestroy` are interpreted by the mod, not the engine.

Resources load in the order game defaults, world overrides, then cars. A module's
callbacks and immutable data must stay alive until all their users are destroyed.
Class registration, resource lifetime and snapshot exports are specified in the
object contract; do not serialize raw module pointers. Cosmetic randomness must
not consume the gameplay random stream.

## Car turbo presentation

[Turbo profiles](turbo.md) bind a shared MR profile to each car. The profile selects
an ordinary mod object class; the engine reports actual applied thrust and retains
fuel/physics. The object owns visuals and sound.

## Car status presentation

[Car effect profiles](car-effects.md) independently select frozen-car and
own-camera invisibility presentation. A separate binding supplies the energy-freeze
launcher; durations stay in TM4 mechanics. The port owns visibility, timer expiry,
sound lifecycle and restoration; callbacks render the existing mesh without
changing simulation state.

Shield presentation remains stock. Engine-sound presentation remains in the mod;
`tm3Engine` is mod-owned data, not an engine key.
