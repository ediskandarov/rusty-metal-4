# Fragment impact effects

`world/fragmentEffects` is a type-2 symbol resolving to an immutable
`Rm4FragmentEffects` descriptor from `port/extensions/fragment_effects.h`.
The loader validates the string, symbol, version, size and callback before object
construction. Omit the entry to retain the original TM4 visual/audio branch and
its random-number sequence. The old `fragmentImpact` function binding is removed.

The provider replaces both visuals and audio for every stock `fragment` collision
on this map. It may intentionally produce nothing. It does not change gravity,
collision detection, flight or removal of the fragment. Custom mod classes such as
`tm3Debris` continue to own their own behaviour.

The synchronous impact event contains world position, effect size (twice the
fragment radius), map material index and that material's surface kind. These last
two values are distinct. Position padding is zero. Event pointers are borrowed;
callbacks must copy values needed by created objects and must not retain the event.

Callbacks run during simulation and replay, not while restoring a snapshot.
Presentation objects use ordinary snapshot schemas, and sounds use the existing
rollback audio lifecycle. Cosmetic decisions use `randrand`, not gameplay `rand`;
sound emitters opt into `RM4_SOUND_EFFECT_RANDOM`. No new mutable provider state is
stored in snapshots. The selected provider is cleared after object teardown and
before resource modules can unload.

The adapter lives in `port/extensions/fragment_effects.c`; the game patch only
reports the collision and preserves the stock fallback. TM3 implements the provider
in `src/shared/world/stage.c`, using its own sprite resources and sound programs.
