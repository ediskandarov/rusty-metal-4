# Evelyn

Evelyn is an original orange rally sedan with an all-wheel-drive tune, fender guns, a forward Ion Lance, and twin turbo exhausts. It uses the game's shared car physics, lighting, effects and laser implementation. The car's body, textures, handling overrides, weapon mounts and synthesized engine loop are authored here.

## Build and load

From the repository root:

```sh
python3 mods/evelyn/tools/build.py
bun run build:mod mods/evelyn/mod.json build/mods/evelyn.tm4mod
```

Drop the package on the website or select it under **Mods** before starting the game. A package with the same ID replaces the saved version. Restart the game to apply changes during a session.

## Edit and verify

Edit the mesh JSON and atlas in `source/`. The mesh includes near and distant groups and exhaust and weapon attachments. The verifier checks the floor-to-bumper edges in both damage states. The exporter generates OBJ and car MR files. `--author` regenerates the editable sources from the procedural design and overwrites edits. Mesh coordinates use metres with Y up and Z forward. The exporter converts them at 80 game units per metre.

```sh
python3 mods/evelyn/tools/build.py --render build/evelyn-review
python3 mods/evelyn/tools/validate.py --self-test --reference-root game
bun tools/resources/validate-car.ts mods/evelyn/resources/EVELYN.MR --strict-associations
```

Check the rotation in Car Selection and drive the packaged model. The game applies wheel pivots and world lighting while driving, and the menu loads a preview with pivots already applied. The software review renders check geometry and texture placement. For original scale and face-budget comparisons, run `reference_budget.py` with your Track 01 image and the game submodule.

## Package specification

A `.tm4mod` is an MR with a `Root` directory containing exactly two entries. `manifest` is a type 2 registry string containing JSON. `car` is a type 3 binary containing a second MR with its own `Root` directory.

```json
{
  "format": "tm4-rewired-mod",
  "version": 2,
  "kind": "car",
  "id": "evelyn",
  "name": "Evelyn"
}
```

The ID starts with a lowercase ASCII letter, followed by up to six lowercase letters or digits. Names use 1–15 ASCII letters, digits, spaces, apostrophes or hyphens and start with a letter or digit. The game sees an eight-character-or-shorter virtual car filename, such as `MEVELYN.MR`. Names and filenames must be unique within the disc and current mod list. The build tool adds `resource` to its input JSON, a path relative to the mod directory that is omitted from the package.

Version 2 requires these car resources.

| Resource | Content |
| --- | --- |
| `display/car.bit`, `display/shadow` | Relocatable bitmap and shadow references. The bitmap uses VRAM word rectangle `(640, 0, 192, 64)`. |
| `display/resolution` | Face, vertex and normal arrays, with contiguous LOD folders starting at `r0`. Each LOD includes groups, counts and a view table. |
| `display/turbo` | One light position and 1–2 exhaust outlets with their own rear-facing mount, width and length. |
| `machineGuns`, `Laser` | Authored launch mounts with positions and normalized Q12 directions. |
| `physics`, `healthEnergyMax`, `radarDotColor` | Car-specific mass, drivetrain, grip, collision dimensions, health and radar color. |
| `special` | HUD name, ammo, delay and recharge for the shared laser behavior. |
| `engineSample` | One looping mono PS1 ADPCM sample. The loader builds the engine sound bank and gives it a session name derived from the mod ID. |
| `info.tim` | Required authored 320×240, 16-bit direct-color TIM. The game displays it from the standard Car Selection Info button. |

Version 2 cars share the game's common systems. Their Info screen shows the authored page without a disc narration track. Version 1 packages with a `base` field continue to load with inherited car resources. Both versions are limited to 4 MiB per package and 16 installed cars per session. The accepted fields, types and bounds are in [the package validator](../../web/src/mods/package.ts) and [the independent car resource validator](../../web/src/mods/independent-car.ts).
