# Evelyn resource prototype

The car is an original interpretation of [Evelyn](https://twistedmetal.fandom.com/wiki/Evelyn),
using [stock WRX proportions](https://www.victorymotorsofcolorado.com/inventory/2002-subaru-impreza-wrx/134976?photos=1).
Dimensions, weathering and equipment details are inferred, not a screen-exact prop replica.
The mesh and textures were authored here; reference images and original-game art are not
included. TM4 cars inform the visual style rather than impose an original-hardware budget.
Authoring meters are a convenience: the original `scale` metadata does not establish
historical real-world units.

Edit the mesh JSON and atlas for asset changes. OBJ is a one-way export; edits to it are
not imported. **`--author` overwrites mesh and texture edits** with the procedural design;
omit it for ordinary export. The focused exporter accepts opaque atlas pixels only
(no PNG transparency), `units_per_meter: 50`, and forward `[0, 0, 1]` machine-gun
directions; unsupported edits fail explicitly.

From the repository root, with Python 3.11 or later:

```sh
python3 mods/evelyn/tools/build.py --render build/evelyn-review
python3 mods/evelyn/tools/validate.py --self-test --reference-root game
bun tools/resources/validate-car.ts mods/evelyn/resources/EVELYN.MR --strict-associations
```

The Bun command also accepts other car display MRs without source assets. Omit
`--strict-associations` to warn about representative reflection positions instead of
requiring each normal to reference its face corner. The Python check additionally
enforces Evelyn's authoring intent. Neither establishes runtime compatibility.

The independent MR reader comes from the [game submodule](../../game/tools/overlay_resources.py).
For original-car comparisons, set `TM4_DISC` to your original Track 01 image; disc data is
not supplied by that submodule:

```sh
python3 mods/evelyn/tools/reference_budget.py --disc "$TM4_DISC" --recovery-root game
```

This is an unregistered display-resource prototype, not a playable car. The future-special
attachment is a placement suggestion, with no weapon behavior. Damage slots share the
same art; additional LODs have not been authored. Later connection needs registration,
physics/collision and presentation choices, followed by in-engine testing.

The [loader](../../game/src/modules/car/model.c) and
[renderer](../../game/src/modules/car/wheel_render.c) provide the resource contract.
Draw ordering is estimated from group centers. Offline checks do not establish correct
engine clipping, ordering, lighting, steering/suspension or shared packet/VRAM behavior.
Review images are software renders of the exported resources, not in-game captures;
visual acceptance remains a separate review.
