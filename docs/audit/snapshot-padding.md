# Snapshot padding inventory

Reviewed against the Wasm32 port. Original game/SDK layouts remain unchanged.

`SnapshotPod` copies its complete byte range. Types with `hash_fields` and car callback records also hash the captured bytes. Other objects use explicit semantic hashes: their unused bytes can change a portable snapshot without changing the simulation checksum. Local checkpoints deliberately preserve raw memory; their contract is different.

Decisions:

- **Excluded:** serialize named members instead of the enclosing storage.
- **Normalized:** keep a wire-format slot, but always encode zero without reading its live padding value.
- **Retained:** a consumer exists, or unused status has not been established.
- **Already safe:** padding is excluded or initialized before serialization.

Verification references below point to the padding cases in [FFA simulation tests](../../tests/simulation/ffa.mjs). **Live** means poison values `0x66`, `0xff`, and zero leave canonical bytes and portable snapshots unchanged; 120 subsequent ticks agree after local rollback and portable recovery. These are real Wasm simulation objects using game constructors and normal tick dispatch, without browser rendering. Display consumers are reviewed in source, not exercised by these headless tests. This does not establish historical intent for the PS1 source.

## Matrix alignment gaps

The current SDK `MATRIX` has two unnamed bytes between the nine rotation halfwords and translation. SDK transforms consume `m` and `t`; copying a complete matrix can propagate the gap. All entries below serialize those two members separately.

| Field                                                                 | Investigation                                                                        | Decision / verification                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `Car.world_light_matrix`                                              | Lighting produces matrix coefficients; display consumes them.                        | Excluded; live.                                        |
| `Car.color_matrix`                                                    | Color-matrix operations read coefficients, not alignment bytes.                      | Excluded; live.                                        |
| `Car.transform`                                                       | Physics, collision and SDK transforms use rotation/translation.                      | Excluded; live.                                        |
| `Car.previous_transform`                                              | Prior-pose operations use rotation/translation.                                      | Excluded; live.                                        |
| `Camera.camera_to_world`                                              | Camera pose and inversion operate on rotation/translation.                           | Excluded; live.                                        |
| `Camera.world_to_camera`                                              | World projection consumes rotation/translation.                                      | Excluded; live.                                        |
| `Camera.previous_camera_to_world`                                     | Prior-pose camera operations use named matrix members.                               | Excluded; live.                                        |
| `Crane.transform`                                                     | Yard crane process, magnet positioning and display use SDK transforms.               | Excluded; live on Construction Yard.                   |
| `WeaponBomb.transform`                                                | Bomb placement/display consume the SDK matrix.                                       | Excluded; live.                                        |
| `RayBeam.placement`                                                   | Ray attachment and placement use rotation/translation.                               | Excluded; live.                                        |
| `RayBeam.beam_to_world`                                               | Ray processing/display use rotation/translation.                                     | Excluded; live.                                        |
| `Lightning.matrix`                                                    | Point generation writes named coefficients; display transforms points.               | Excluded; live.                                        |
| `WebCarpart.part.rotation_step`                                       | Debris rotation uses coefficients; the gap has no arithmetic consumer.               | Excluded in the earlier fix; live death/rollback test. |
| `WebCarpart.part.local_to_world`                                      | Poisoning this gap reproduced the recorded false object-hash divergence.             | Excluded in the earlier fix; live death/rollback test. |
| `PathingInfo.local_to_world`, `previous_local_to_world`               | Pathing descriptors already serialize `m` and `t`.                                   | Already safe.                                          |
| `Helicopter.top_blade_rotation`, `tail_blade_rotation`                | Moving-world descriptors already serialize `m` and `t`.                              | Already safe.                                          |
| `WeaponProjectile.model_to_world`, `WeaponTarget.transform`           | Projectile/effect descriptors already serialize `m` and `t`.                         | Already safe.                                          |
| `CarShovelState.target_transform`, `CrusherPinchers.target_transform` | Callback-state descriptors already serialize `m` and `t`, including in their hashes. | Already safe.                                          |

Implementations: [cars](../../port/web/snapshot_car.c), [scene](../../port/web/snapshot_scene.c), [yard](../../port/web/snapshot_yard.c), [effects](../../port/web/snapshot_effects.c).

## Vector fourth halfwords

These entries have an actual `SVECTOR.pad` with no identified semantic consumer. Writers/readers were traced through the owning module and XYZ helpers. They serialize XYZ and classify `pad` as transient. This excludes its value; it does not require live memory to contain zero.

| Field                                                    | Investigation                                                                                                             | Decision / verification                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `Car.position`                                           | Movement, collision and object positioning read XYZ.                                                                      | Excluded; live.                                 |
| `Car.previous_position`                                  | Movement history reads XYZ.                                                                                               | Excluded; live.                                 |
| `CarParticle.previous_position`                          | Wheel/body contact processing uses XYZ.                                                                                   | Excluded; live.                                 |
| `CarParticle.position`                                   | Contact positioning uses XYZ.                                                                                             | Excluded; live.                                 |
| `CarParticle.normal`                                     | Force/dot-product operations consume three components.                                                                    | Excluded; live.                                 |
| `CarSpring.direction`                                    | Spring force calculation consumes XYZ.                                                                                    | Excluded; live.                                 |
| `Car.lights[].light_vector_world`                        | `lighting.c` copies and normalizes XYZ. Array elements are now described individually.                                    | Excluded; live.                                 |
| `LightEmitter.previous_world_position`                   | Light motion updates/copies XYZ.                                                                                          | Excluded; live.                                 |
| `LightEmitter.world_position`                            | Lighting and object placement consume XYZ.                                                                                | Excluded; live.                                 |
| `LightEmitter.direction_world`                           | Constructor and motion operations use XYZ.                                                                                | Excluded; live.                                 |
| `Crane.magnet_position`                                  | Transform, collision, explosion and car positioning use XYZ.                                                              | Excluded; live.                                 |
| `RayBeam.hit_world`                                      | Ray intersection and impact-effect creation use XYZ.                                                                      | Excluded; live.                                 |
| `Lightning.start`                                        | Point generation and origin placement use XYZ.                                                                            | Excluded; live.                                 |
| `Lightning.end`                                          | Length/direction calculation and endpoint placement use XYZ.                                                              | Excluded; live.                                 |
| `Lightning.points[]`                                     | Generation/display access XYZ. All existing coordinate slots remain in the format; only their pad halfwords are excluded. | Excluded with an inline-array descriptor; live. |
| `CarJump.world_position`                                 | `car/jump.c` integrates and displays XYZ.                                                                                 | Excluded; live.                                 |
| `CarJump.frame_displacement`                             | Jump movement uses three components.                                                                                      | Excluded; live.                                 |
| `FireRing.axis`                                          | Axis-to-quaternion conversion reads XYZ.                                                                                  | Excluded in the earlier pass; live.             |
| `FireRingParticle.position`                              | Polygon checks and animation creation read XYZ.                                                                           | Excluded in the earlier pass; live.             |
| `FlameEmitter.world_direction`                           | Matrix/vector operations consume XYZ.                                                                                     | Excluded in the earlier pass; live.             |
| `FlameEmitter.world_velocity`                            | Launch velocity scaling consumes XYZ.                                                                                     | Excluded in the earlier pass; live.             |
| `WebCarpart.part.collision_origin`                       | World ray intersection and GTE projection consume XYZ.                                                                    | Excluded in the earlier pass; live.             |
| `PathingInfo.world_samples[]`                            | Descriptor already lists XYZ and transient pad.                                                                           | Already safe.                                   |
| `SoundEmitter.previous_position`, `position`, `velocity` | Sound descriptors already list XYZ and transient pad.                                                                     | Already safe.                                   |
| `Bullet.previous_world`, `current_world`                 | Projectile descriptors already list XYZ and transient pad.                                                                | Already safe.                                   |
| `WeaponFireball.previous`, `velocity`                    | Fireball descriptors already list XYZ and transient pad.                                                                  | Already safe.                                   |

## Other records and nested copies

| Storage                                                                                                                         | Investigation                                                                                                                                                                                             | Decision / verification                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Car.controls.input_history[].padding`                                                                                          | Input processing shifts whole events but reads/writes only `buttons` and `time`. Whole `CarControls` serialization previously included ten irrelevant bytes.                                              | Excluded using control/event descriptors; live. Other control fields, including `unknownf38` and `unknownf3e`, are preserved. |
| `PadCache.reserved03` in `SessionRecord.players[].input`                                                                        | No input consumer found. Copying `PadJpad[slot]` overwrote this byte despite zero-initializing the outer record.                                                                                          | Normalized to zero on capture and restore; live. The record slot remains for alignment.                                       |
| `CarRenderFace` byte before `texture`                                                                                           | Compiler layout has a byte after `reflection`. Current renderers read named fields and texture/vertex regions; no packed consumer of this byte was found. Original file-format intent is not established. | Excluded in the earlier pass; live debris test. Resource/engine layout remains intact.                                        |
| `SessionRecord` outer alignment gaps                                                                                            | Record is explicitly zeroed before field assignment. Nested copies were examined separately.                                                                                                              | Already deterministic; no wire-layout rewrite.                                                                                |
| `DriverBinding` final alignment byte                                                                                            | Explicitly zeroed before members are assigned. Copied faces contribute only their reflection byte; no whole `CarRenderFace` copy here.                                                                    | Already deterministic.                                                                                                        |
| `CarConstruction.model[]` unused suffix                                                                                         | Construction scratch is zeroed before the model name is copied.                                                                                                                                           | Already deterministic.                                                                                                        |
| `ObjectRecord.class_name[]` unused suffix / record storage                                                                      | Capture zeroes the record and writes explicit fields; position has only three shorts.                                                                                                                     | Already deterministic.                                                                                                        |
| `CameraBinding`, `TimerBinding`, `PathResource`, `SquareRecord`, `DeviceRecord`, `HealthRecord`, snapshot header/object lengths | Current compiler layouts have no unnamed gaps; unused array entries are initialized where present. `HealthRecord.unknown06` is a field, not inferred padding.                                             | Retain.                                                                                                                       |
| `WebParticipantState`, `WebParticipantId`, `WebFfaResult`                                                                       | Their serialized members consist of fixed-width words/arrays without alignment gaps in Wasm32.                                                                                                            | Retain.                                                                                                                       |
| World mutations                                                                                                                 | `snapshot_world.c` explicitly emits byte/halfword values and handles, including XYZ for vertices.                                                                                                         | Already safe.                                                                                                                 |
| Rust protocol                                                                                                                   | Serde serializes fields, not Rust struct storage. Snapshot byte buffers are opaque C-produced data.                                                                                                       | No Rust padding copy found.                                                                                                   |

## GTE and local rollback

[The PsyZ patch](../../port/psyz/patches/gte-checkpoint.patch) has two capture contracts:

- `WebCheckpointGteCapture`: raw state for same-instance rollback and temporary rendering isolation.
- `WebSnapshotGteCapture`: copies state and normalizes only the gaps below. Capture never alters the live GTE.

Compiler layout confirms these gaps in the current 216-byte Wasm32 GTE state:

| Storage                                            | Investigation                                                                                             | Decision / verification                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `gte.v0.pad`, `v1.pad`, `v2.pad`                   | GTE vector operations and register reads use XYZ; Z reads explicitly sign-extend `vz`.                    | Normalize six bytes in portable output; live.        |
| Alignment inside `gte.m`, `l1`, `l2`               | SDK matrix operations and control-register access select coefficients/translation.                        | Normalize six bytes in portable output; live.        |
| Gap after `gte.sz3`, before `mac0`                 | Compiler inserts two unnamed bytes; no field or register maps to them.                                    | Normalize using `offsetof`, not fixed offsets; live. |
| `gte.res1`                                         | Despite “reserved” in the register description, `Psyz_GteDataRead/Write(23)` exposes its value.           | Retain.                                              |
| `CVECTOR.cd` and other GTE register values         | Represent command/color or arithmetic state; not compiler padding.                                        | Retain.                                              |
| Local checkpoint arena, roots and world undo bytes | Restore exact same-instance memory and allocation state; not directly used as the canonical network hash. | Intentionally retain raw storage.                    |

The live fixture verifies both portable equality and exact restoration of the poisoned raw GTE checkpoint, then compares 120 ticks with normalized state and a fresh portable restore.

## Packed state that must remain

| Type / region                                                                    | Actual payload / decision                                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `BulletMotion` fourth halfword                                                   | Collision flags; retain.                                                                                        |
| `BulletImpact`, `WeaponFireballPosition` fourth halfword                         | Damage; retain.                                                                                                 |
| `PowerupPosition` fourth halfword                                                | Regeneration/active state; retain.                                                                              |
| `ExplosionWaveMotion` fourth halfword                                            | `affects_owner`; retain.                                                                                        |
| `Tm4WorldHitSurface`                                                             | Normal plus material; retain.                                                                                   |
| `AnimPartOffset` fourth halfword                                                 | Texture animation period; retain.                                                                               |
| `CarWheelDirection` fourth halfword                                              | `unknown0e` is assigned by physics; the other byte is displacement. Unknown meaning does not authorize removal. |
| `CarRenderGroup.center` fourth halfword                                          | Validity and sorting fields; retain.                                                                            |
| `WeaponTrailColorStep`, `Tm4PackedColor`, texture unions                         | Packed channels/commands/UV/CLUT/page fields; retain.                                                           |
| `Ribbon` / `WeaponTrailPoint`, `Tm4VectorXYZ`, `Tm4ShortVectorXYZ`, `CarAiPoint` | Component-only layouts; no extra SDK pad.                                                                       |
| Other `unknown` fields, inactive array entries and display-only values           | Not classified as padding merely because the canonical hash omits them. Retain unless investigated separately.  |

## Verification and limits

The fixtures are [FFA](../../tests/simulation/ffa.mjs), [participant membership](../../tests/simulation/participant-membership.mjs), and [respawn](../../tests/simulation/participant-respawn.mjs). The dedicated hook is [snapshot_padding.c](../../tests/native/hooks/snapshot_padding.c); earlier fire/debris cases use [participant.c](../../tests/native/hooks/participant.c).

Rare-effect scenarios use the stock Construction Yard resources and an Orbital owner:

| Scenario  | Creation and covered fields                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bomb      | Real `weaponBomb` constructor with the `remote` style; transform gap.                                                                                    |
| Ray       | Real `weaponRayBeam` constructor with the first loaded ray style, world placement and effects enabled; both matrix gaps and hit-position pad.            |
| Lightning | Real emitter with the first loaded lightning style; its constructor creates the bolt. Matrix gap, both endpoint pads and all 15 point pads are poisoned. |
| Light     | Real positioned, directional light with explicit intensity; all three vector pads.                                                                       |
| Jump      | `CarDisplayJumpConstructor`; both vector pads, including normal expiry after eight ticks.                                                                |

Each scenario checks every field independently before advancing, then re-poisons live instances before every tick. Local rollback runs with zero padding and compares the same object counts and canonical state. Portable recovery starts in fresh instances from six snapshots: creation and after 1, 3, 6, 16 and 61 ticks. Every replay runs to the same 120-tick endpoint. The tests require effects to exist after their first processed tick; the jump must also expire normally.

A temporary negative-control build restored whole-aggregate copies only for these rare-effect fields. All 13 independently poisoned field groups failed portable-byte equality, while their canonical checksums stayed equal. The checked-in descriptors pass: this confirms the fixtures detect accidental reintroduction of padding serialization. The deliberately broken build is not part of the repository.

These fixtures cover simulation and snapshot semantics, not visual correctness or every resource style/impact path. The inventory applies to the pinned Wasm32 build, not arbitrary ABI layouts. SDK/submodule updates require rechecking aggregate layouts and new `SnapshotPod` fields.

Portable snapshot/session versions were advanced for the new field layout. Client and server must use a matching build; local raw-checkpoint behavior and the canonical simulation hash schema are unchanged by this pass.
