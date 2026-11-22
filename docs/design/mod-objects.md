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

Level teardown discards checkpoints, destroys instances, invokes MR class destructors,
then releases class tables, interaction pairs and class-to-snapshot bindings. Only
then are resource registrations removed in reverse load order: cars, world, game.
Modules retained by another registration stay loaded, but their level classes must
be registered again on the next load. Raw callback pointers must not outlive the
registration that owns their module.
