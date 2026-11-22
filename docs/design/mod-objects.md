# Resource-module objects

Mods use the original object API in `tm4/main/object.h`, including class and
interaction registration. Engine-private class tables are not part of that API.
Use `snapshot_types.h` for snapshot descriptions and `module_import.h` when calling
functions owned by reloadable modules. Resource modules must not suspend execution.

Register classes and interaction pairs during class construction, before the first
simulation tick. A class name is copied; its registry directory and callbacks must
remain valid until object teardown. Duplicate classes or occupied interaction pairs
return failure. Failed registration preserves previously registered classes; it does
not undo earlier successful registrations in the same constructor.

MR-backed classes keep the original naming conventions and
`objects/<class>/instances/startup/<instance>` layout. Packed constructors receive
`va_list`; instance constructors receive their instance directory. Class constructors
and destructors receive the class directory, not an instance or argument list.
Dynamically registered helper classes share the same level lifetime. Their resources
must be released by the owning MR class destructor, after all instances are gone.

Snapshot-capable classes export a matching `SnapshotType` through the module's
`__rm4_snapshot_types` table. Describe mutable payload fields and references; never
serialize module addresses. Missing or size-mismatched descriptions block snapshots.
Class registration and resource loading are not replayed by rollback.

Car behavior modules describe their callback context through
`const SnapshotType* describe(const Car*)`, exported as `__rm4_car_snapshot_type`.
Return NULL for other cars; identify the complete callback combination, including
rendering. The descriptor must remain valid while the module is loaded. Its size
must equal the behavior's `Car<Name>Sizeof` allocation (zero if absent), and its
name must be nonempty and stable. Describe mutable fields and object references;
raw module pointers are never snapshot data. Resources are prepared before fields
are restored; the gameplay constructor is not rerun. The context contributes to
both snapshots and simulation checksums.

A car collision callback returning `CAR_COLLISION_END_CONTACT` ends the entire
pair interaction, including the other callback, contact history, impulses and
ordinary collision damage. Return it immediately if either car was destroyed;
impulse-suppression flags alone do not protect destroyed objects.

Level teardown discards checkpoints, destroys instances, invokes MR class destructors,
then releases class tables, interaction pairs and class-to-snapshot bindings. Only
then are resource registrations removed in reverse load order: cars, world, game.
Modules retained by another registration stay loaded, but their level classes must
be registered again on the next load. Raw callback pointers must not outlive the
registration that owns their module.

Screen-space effects use `port/extensions/screen_objects.h`. Register the object's
screen callback after its ordinary class; leave world display NULL for purely
screen-space objects. Process and snapshot fields own the effect's lifetime and
colour. Screen drawing only emits packets into frame-owned storage and never
advances state. The pass covers the complete output, including widescreen and
split-screen, above scene/HUD and below global messages and view borders. It keeps
stock TM4 overlays intact. Registrations reset with object classes before modules
unload; restored instances reuse their class's callback without storing pointers.
