# Map weapon profiles

The port extension lives in `port/extensions/weapon_profiles.{h,c}`. It replaces
TM4's fixed weapon table with a registry and a per-map arsenal, while retaining
its launchers, projectiles and vehicle specials. `port/game/car_weapons.c` adapts
the car inventory lifecycle; `patches/game/weapon-profiles.patch` connects these
implementations to the car module, HUD and AI. The extension is compiled inside
the car module so its registry follows the same resource lifetime.

MR defines `/weaponProfiles/<id>` and `/world/arsenal/<entry>`. Profiles are loaded
once by the car class constructor after module loading. The registry freezes before
cars are created and is released after their destruction. There is no mid-match
registration API. The registry has a resource-safety limit of 1024 profiles; a map
selects 1–20, including exactly one position with the `special` role. Vehicle-special
mechanics and their per-car resource configuration remain unchanged.

The original disc's `/objects/car/weapon/list` supplies stock profiles. Without an
explicit arsenal, its list supplies the map's selection and switching order. This
is a disc-format adapter: runtime inventory indices no longer identify stock weapon
types. Custom IDs must not collide with stock or other custom IDs (case-insensitive).

```text
weaponProfiles/myHoming/
  launchFunc = "Tm3LaunchWorldProjectile"
  prepareFunc = "Tm3PrepareWorldWeapon"
  projectile = "Tm3ProjectileType_Homing"
  initial = 0
  max = 10
  delay = 4096
  model = "homing"
  aiCategory = "homing"

world/arsenal/primary/
  profile = "myHoming"
  order = 0
  initial = 2
world/arsenal/special/
  profile = "Special"
  order = 1
```

`order` is required, unique and contiguous, independent of MR directory order.
A profile can appear only once in an arsenal. `initial` can override starting ammo,
but cannot exceed the profile's `max`. `delay` is Q12 seconds. `repeat` and `detonate`
are boolean scalars. `hudName` is display text; `model` selects a powerup appearance.
Pickup types credit an inventory profile by ID; custom pickup types can reuse stock
geometry resources. They do not have to occupy any original weapon number.

`launchFunc` is a required module export for ordinary custom profiles. Optional
`prepareFunc` has type `CarWeaponPrepare`: it validates launcher-specific MR fields
and returns immutable module/resource-owned data in `launch_data`. It must not spawn
objects or consume simulation randomness. It runs before class resource acquisition.
The launcher receives the existing `CarWeaponLaunch` arguments. Returning 1 requests
ammo consumption; returning 0 can also represent deferred consumption, not just failure.

Roles `freeze` and `massive` bind combo actions; `special` binds the existing vehicle
special. Each role can occur at most once. Missing optional action roles disable that
action. Ordinary profiles have no role.

## AI categories

Weapon implementation and AI preference are separate. Every custom profile requires
`aiCategory`; `tm3Homing` and a future `tm2Homing` can both use `homing`. Cars and maps
address categories, never weapon IDs or arsenal positions:

```text
weaponAiCategories/myMod:beam/
  defaultWeights = [12 bytes]
weaponProfiles/myBeam/
  aiCategory = "myMod:beam"
  launchFunc = "MyBeamLaunch"

# Relative to the car resource:
ai/weaponWeights/myMod:beam = [12 bytes]
# At the world root:
world/ai/weaponWeights/myMod:beam = [12 bytes]
```

Category declarations may live at `/weaponAiCategories` or in a resource pack's
`weaponAiCategories` directory. The registry freezes before profiles and cars are
constructed; category IDs are case-insensitive. Duplicate declarations (including
built-in names), unknown profile references, and missing/malformed defaults fail
loading. There is a 1024-category resource limit, independent of the 20-position
arsenal. Mods should namespace new categories to avoid collisions.

Arrays use MR type 18, length 12, indexed by AI sector. Car preferences override
category defaults; an explicit zero is retained. Map values multiply preferences
with integer `car × map / 100`; an unspecified multiplier is 100. Effective weights
are normalized with integer division before selection. A category only controls
weapon choice, not aiming, charging, placement or other special AI tactics.

Built-in categories adapt the original TM4 weapon columns. For them, missing named
car/map values come from the original positional resource tables. This preserves
stock disc behavior without tying custom categories to those columns. Profile-local
`aiProfile` and `aiWeights` are not supported. TM3 conversion emits common category
names for shared weapon types and namespaced categories for its unique map weapons.

Bindings resolve once during loading and remain immutable. Snapshot restore retains
the receiving car's resource pointers; category identity contributes to the profile
key. Reordering the arsenal does not change preferences.

Inventory entries carry a profile key checked against the frozen arsenal on capture
and restore. Portable snapshots rebuild descriptors from the matching resources,
retain destination-local pointers, and restore ammo, timing and active devices. The
network's existing build/content compatibility checks remain required; profile keys
are identity checks, not a replacement content digest. Delayed effects must retain
the launching profile's identity instead of a historical weapon number.
