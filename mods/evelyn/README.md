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
bun run build:mod mods/evelyn/mod.json build/mods/evelyn.tm4mod
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

## Specification

Version 1 supports **additional cars with inherited behavior**. A `.tm4mod` is an MR
container, not a ZIP archive. It contains exactly two entries and no subdirectories:

```text
Root/
├── manifest    JSON string (MR type 2)
└── car         Complete car resource MR (MR type 3)
```

### Manifest

Example of the manifest stored inside the package:

```json
{
  "format": "tm4-rewired-mod",
  "version": 1,
  "kind": "car",
  "id": "evelyn",
  "name": "Evelyn",
  "base": "thump"
}
```

All fields are required; additional fields are rejected.

| Field | Accepted value |
| --- | --- |
| `format` | `"tm4-rewired-mod"` |
| `version` | `1` |
| `kind` | `"car"`; maps, menu extensions and executable code are not supported |
| `id` | 1–7 lowercase ASCII letters or digits, starting with a letter |
| `name` | 1–15 ASCII letters, digits, spaces, apostrophes or hyphens; starts with a letter or digit, no trailing space |
| `base` | Base car filename without extension, present on the user's disc; 1–8 lowercase ASCII letters or digits, starting with a letter |

For example, `evelyn` becomes the virtual filename `MEVELYN.MR`. The `m` prefix and
alphanumeric restriction keep it compatible with the game's eight-character filename
loader. Names must not conflict with existing cars, and virtual filenames must not
replace existing resources. Uploading the same ID again updates the saved package.

### Car resources

The nested MR has a `Root` directory. Its principal entries are:

```text
Root/
├── machineGuns                  Optional muzzle positions and directions
└── display/
    ├── car.bit                  Required model texture and palette allocation
    ├── shadow                   Optional shadow data; otherwise inherited
    └── resolution/              Complete geometry replacement, including LODs
        ├── FaceList
        ├── VertexList
        ├── VertexNormalList
        ├── …                    Counts and optional scale/translate metadata
        └── r0/                  First LOD; additional LODs may use r1…r8
            ├── viewtable
            ├── …                Counts and display distance
            └── Groups/
```

This is a resource layout, not a directory that can be zipped into a mod. Use a car MR
exporter, such as Evelyn's, then package its output. The exact accepted entries and
validation rules are implemented in [package.ts](../../web/src/mods/package.ts) and
[car-display.ts](../../web/src/mods/car-display.ts).

Packages are limited to **4 MiB**, with at most **16 mods per session**. Geometry must
have valid indices, group/frame ranges and renderer scratch requirements. Texture
references must remain within the supplied bitmap. Version 1 requires the relocatable
bitmap rectangle `(640, 0, 192, 64)`, measured in VRAM words, not image pixels.
`machineGuns`, when supplied, contains 1–8 position/direction records of 16 bytes each
(MR type 26). Unknown resources and arbitrary registry changes are rejected.

Physics, collision settings, sounds, special-weapon behavior and the information page
come from `base` on the user's disc. The mod supplies its own geometry and bitmap;
optional muzzle and shadow data override the base values. No base-game resources need
to be distributed in the package.

### Build and load

The build configuration adds a `resource` path to the manifest. This field is used only
by the build tool and is omitted from the packaged manifest:

```json
{
  "format": "tm4-rewired-mod",
  "version": 1,
  "kind": "car",
  "id": "evelyn",
  "name": "Evelyn",
  "base": "thump",
  "resource": "resources/EVELYN.MR"
}
```

The resource path is relative to `mod.json` and must resolve inside its directory.
Build without compiling the game or supplying a disc:

```sh
bun run build:mod mods/evelyn/mod.json build/mods/evelyn.tm4mod
```

Drop the resulting `.tm4mod` anywhere on the website, or select it under **Mods**.
The browser validates and stores it locally. Before launch, select the user's disc;
during a running game, restart to apply changes. Missing base resources prevent the
mod from being installed. Original disc files and original cars remain unchanged.

### Evelyn-specific limitations

Evelyn is a visual prototype using `thump` behavior, not a separately balanced vehicle.
Its proposed special-weapon attachment has no behavior. Damage frames share the same
art and only one LOD is authored; both conditions produce warnings rather than errors.

Menu vertices are baked into car coordinates while driving geometry retains local
wheel pivots. Faces use TM4's positive-NCLIP convention and inward lighting normals;
packet prepending reverses the submission order of layered surfaces. See the game
[loader](../../game/src/modules/car/model.c) and
[renderer](../../game/src/modules/car/wheel_render.c) for the runtime layout.

Offline validation does not establish correct clipping, draw ordering, lighting,
steering/suspension or shared packet/VRAM behavior. Exporter review images are software
renders; inspect the packaged car in-game as well.
