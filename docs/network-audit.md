# Network implementation audit

Updated 2026-11-11 for the experimental networking implementation.
The [v0.1 requirements](network-requirements-v0.1.md) remain the acceptance contract;
this page records actual coverage and limitations, not revised requirements.

## Current boundary

C owns gameplay, including physics, weapons and scoring. The Rust server embeds
Wasmtime 47.0.1 and runs that same wasm32 C simulation as a WASI reactor. Lightyear
selects accepted inputs and advances it synchronously on its 30 Hz timeline. There
is no server browser, JavaScript runtime, Python host, or simulation subprocess.
Clients agree on a start tick before prediction begins. A delay over 250 ms
fails the session explicitly. After initial readiness, clients cannot gate the
authority.

Both browser and server run Lightyear 0.30.1 / Bevy 0.19. The browser Rust/Wasm module
is separate from Emscripten. wasm-bindgen copies owned strings at the JS boundary;
Emscripten receives scalar controls and temporary `ccall` strings that C resolves to
its own registry names. No pointer or linear memory is shared between Wasm modules.
The wire uses typed binary Lightyear messages, not JSON WebSocket payloads.

Controller ownership is replicated through Lightyear entities. Its native input
plugin buffers tick-indexed records and validates controlled targets. The server
reads every newly received buffer record before fixed-step trimming, then applies
an explicit game-tick acceptance policy. Connection synchronization, typed channels,
replication ownership, bandwidth priority, RTT/jitter and packet conditioning are
live. Network play uses native prediction and rollback for supported stock
Deathmatch rosters. The authority tests portable capture
at startup before the server issues reconnect credentials. The diagnostic build
includes a smaller native rollback probe.

Sources: [Rust protocol](../network/src/protocol.rs),
[browser runtime](../network/src/browser.rs), [JS ownership bridge](../web/src/network/transport.ts),
[embedded simulator](../network/src/simulator.rs), [C host boundary](../port/headless/api.c).

## Implemented changes and verification

- Direct initialization accepts stable world/car names, validates required file
  presence, resets session configuration and seeds both gameplay RNG entry points
  before `GamePrepareSession` resets the mode. It requires no menu, movies,
  synthetic controller activity, user gesture, animation callback or presented frame.
  Missing-file rejection is retryable; deeper corrupt-resource/constructor failure
  recovery has not been implemented.
- Authority has no viewport or audio device. A client maps its one camera, HUD,
  local-message queue and listener to its gameplay slot. No slot-zero car/camera
  substitution remains. Existing gameplay slots and rules remain intact.
- Compatibility includes protocol version, the client C/Rust build and bound server Wasm hash, and hashes of
  locally supplied gameplay archives/images/sound banks. Optional music/movies and
  menu files are excluded. Fingerprints are compatibility checks only. Roster and
  map selection use names supplied by the authority; local exposed cheats are blocked.
- Lightyear carries controller samples and the authority's accepted input history.
  The server retains a bounded acceptance queue for each slot, preserves button
  edges, and expires held input after nine ticks. Future acceptance and the queue
  are bounded to 60 ticks and 60 records. Prediction verifies C results against
  accepted inputs at the same native tick.
- A departed client loses queued controls immediately; its car remains in combat
  under original game rules. Survivors continue. Finished/error paths release C resources,
  input queues and callbacks, permitting another direct initialization in the page.
- The server journals startup identity, accepted controls, per-tick checksums and
  mode transitions to an append-only file. Inputs are the only externally
  scheduled gameplay commands in the current mode. The first 8 MiB of packed
  rows are cached in memory. Additional rows are read from disk during replay.
  A 1 GiB worst-case per-match disk budget ends the match explicitly if reached.
- Network sound emitters expire and fade on simulation ticks. SPU completion, voice
  assignment and listener choice govern playback only. Replay suppresses mixing and
  marks already replayed one-shots as finished for presentation. Offline sound keeps
  its existing expiry policy. Network rendering restores the secondary RNG after
  drawing so turbo effects cannot change the next simulation checksum.
- Diagnostic limits include loopback-only listening, 16 KiB WebSocket messages,
  bounded write buffering, 128 unacknowledged session messages, 13 links, 120 session messages/second/link, 128 received
  bridge messages, 90 ticks without client progress, ten seconds for unidentified
  connections, 45 seconds for loading and five minutes for a lobby. These are local
  experiment safeguards, not proof against hostile public traffic; native-input
  amplification and all library-internal queue limits still need adversarial review.

[Direct-startup checks](../tests/browser/check_network_startup.cjs) cover zero presented
frames, 60 accepted steps repeated after stop/start, all eight control slots, a missing
resource followed by retry, stale/incomplete tick rejection and blocked local cheats.
Equality here covers the published gameplay checksums.

[Admission checks](../tests/browser/check_network_admission.cjs) cover explicit
rejection of an unsupported map and roster before the first predicted tick.

[Rendered gameplay checks](../tests/browser/check_network.cjs) exercise nonzero-slot
control, car contact, weapon damage, a lethal hit, scoring, round completion and
same-page C reinitialization.
The diagnostic fixture places cars and adjusts target health identically in each
instance. It is controlled gameplay evidence, not arbitrary-world determinism.

## Remaining blockers

### Canonical state coverage — R4/R5

[The C field writer](../port/web/net_state.c) emits a bounded diagnostic record and
checksums for the session, cars, objects, world and sound. It covers both RNGs, pad
edges, car physics and weapon inventory, object order/ownership, projectiles,
known timers, collision histories and Construction Yard object state. Network object
serials are reserved before constructors so nested objects receive unique handles.
Detonation devices use a car handle and weapon slot. Stock projectile callbacks
must agree with the loaded resource type. Keys and numeric IDs replace process pointers. Presentation voice IDs and GPU state
stay out of the record.

[The replay browser check](../tests/browser/check_network_replay.cjs) compares those
checksums per tick and encoded bytes at selected ticks across reset and a separate
instance. Its scripted contact, target and crane setup runs identically on each direct
simulation. The disk tests exercise an eight-slot 15-minute recording, forced
cache spill, corrupt records and incomplete files.

### Same-instance C checkpoint

An opt-in headless Construction Yard Deathmatch can retain a same-instance checkpoint.
Capture requires a completed simulation tick with no staged input. Restore rewinds
the same running instance, then the ordinary C step accepts recorded controls.
During replay the headless instance suppresses external tick publication, audio
playback, rumble and presentation. Finishing replay re-enables tick publication.

The checkpoint preserves the fixed-address simulation allocation arena, including
allocator headers, live objects, weapons, contact histories and gameplay sound emitters.
It also saves session and input state, both RNG streams, the game clock, GTE registers
and object/grid roots. Registry assets and class tables stay loaded in their original
arena. World mutation hooks save touched geometry, display and collision flags,
and navigation links in the resource arena. The undo log rejects addresses outside
that arena. A resource allocation or free, unsupported object state or an exhausted
world undo log also invalidates restoration. The experiment
uses a 4 MiB simulation arena and up to 2,048 world edits. Stopping the match
releases the history. The headless checkpoint test and the rendered live mode use
the same allocator and world undo log. Bots, car packs, independent Wasm
modules and sanitizer builds are outside the checkpoint scope.

[The local checkpoint check](../tests/browser/check_local_checkpoint.cjs) uses
Orbital and Pizza Boy in an offline diagnostic browser reference. It restores tick 80 with a live projectile
and compares the canonical bytes and all five subsystem checksums on each of 180
replayed ticks, three times. Combat exercises steering, contact, weapon damage and
projectile creation, impact and removal. A second case destroys and restores scenery,
including its display and collision state, and checks another 180 ticks. The test
also perturbs car, world and RNG state and hides a startup archive while restoring.

### Portable reconnect checkpoint — R4/R7

Portable checkpoints restore into a separately initialized C instance at tick
zero. The existing object class registry binds per-type field descriptions.
A shared walker allocates shells, then resolves object serials and local resource
keys, restores owned arrays and lists, and rebinds exceptional callbacks. Session
roots, clocks, RNGs, grid order and world-resource edits are saved separately.
Assets, device voices and heap addresses stay local. Restore validates structure and gameplay digests
and resets the destination on failure. Interaction extenders must share their
owner's root. Only that root may own the collision `seen` list.

Portable session roots support 2–8 active human participants without mods or
eliminated players. Capture records the actual count; restore checks distinct
player/car/camera bindings and the car-order permutation before committing.
Fresh-instance and in-place replay checks cover 3, 4 and 8 participants on
Construction Yard. Rendered Wasmtime reconnect covers two, four and eight active
players with combat, native warmup corrections and independent same-tick checks.
The eight-player case conditions every client at 72±12 ms, repeats interrupted
and corrupt transfers, and keeps seven survivors advancing during recovery.
All 22 stock cars, including the nine locked cars, were verified individually on
Construction Yard. All 16 original maps were verified
with Orbital and Pizza Boy. The checks include live weapon and grab state,
Minion's freeze and thaw, the Oil Rig helicopter and its pickup drops, Neon City's
train and UFO, The Carnival's coaster, and shared destructibles, jump pads,
teleporters and fall hazards. The
[independent browser check](../tests/browser/check_portable_checkpoint.cjs)
relocates both resource and simulation allocations and compares canonical bytes
and all five checksums on each replayed tick.

Admission resolves stock resource names and checks the active object graph. Cars
and player cameras must retain their startup identities. Unrecognized types and
unbound state fail capture. Live mesh fragments and shield or invisibility model
copies can delay capture. After bounded retries the player can reconnect again.
Frozen faces are rebuilt from the locally loaded car model.

Closed transport links are reclaimed after their control marker is removed;
the persistent controller entity and resume identity remain. Native replay reads
the applied-input history, including reconnect warmup before local commands exist.

The authority captures one completed tick and continues stepping while the server
forwards the checkpoint in acknowledged 8 KiB chunks. An attempt allows up to
256 KiB of snapshot data, 240 accepted catch-up ticks and 12 seconds. The final
bounded block waits until its frontier exists, avoiding serial partial-block
round trips. Resume preparation installs Lightyear's prediction manager with
rollback disabled so accepted native input is retained instead of drained.
The existing `PredictionWindowWait` also bounds this phase against the actual
input frontier; C prediction and checkpoint history remain inactive.

If an offer arrives beyond the 12-tick rollback window, the client may retarget
at most twice using the current native timeline. Catch-up extends from the
already verified C head without restoring again or ending replay. Retargeting
preserves the original tick and time budgets. The server retains only the latest
12 complete confirmation frames and requires contiguous coverage before granting
live control. An exhausted attempt closes; a fresh retry preserves the participant
identity and leaves survivors running. At handoff,
Lightyear's `StateRollbackMetadata` requests a bounded rewind of its synchronized
timeline to the imported checkpoint. Its fixed schedule brings the C world to
the predicted head, then input mismatches use ordinary Lightyear rollback.
Each catch-up and confirmed tick is checked against the authoritative digests.
The journal remains available for recording and diagnostics.

### Native Lightyear rollback probe

The diagnostic probe uses the same headless C world with two stock cars. A loopback
Rust peer sends delayed native `InputMessage<NativeStateSequence<Input>>` packets.
Lightyear's `ClientInputPlugin` compares received inputs with its `NativeBuffer`.
With input `RollbackMode::Check`, `RollbackSystems::Check` selects the tick before
the first mismatch. `RollbackSystems::Prepare` restores a locally registered
`CheckpointTick` on the `DeterministicPredicted` world entity. The adapter reads that
handle after Prepare and restores the C payload. Lightyear then reruns `FixedMain`,
which resolves inputs in `FixedPreUpdate` and calls the ordinary C step in
`FixedUpdate`. `EndRollback` ends C replay mode.

C owns the checkpoint payloads and resource undo log. Lightyear owns input history,
the rollback decision, and the repeated ticks. The browser bridge passes scalar
inputs and checkpoint tick IDs between the separate Wasm instances. The rolling
history keeps the current checkpoint and up to 12 prior ticks with an 8 MiB
snapshot budget. Its world undo marks share one log. Restoring a tick reverses only
later mutations and discards later checkpoints. Eviction releases log entries older
than the oldest retained tick. Lightyear refuses corrections beyond 12 ticks, and
the adapter stops the probe when that happens.

[The browser probe check](../tests/browser/check_lightyear_rollback.cjs) compares
canonical bytes and all five subsystem checksums on every repeated tick against an
independent run of the final inputs. The peer releases scripted inputs over
Lightyear on loopback, with the browser test advancing the fixed clock. This
exercises native receipt and rollback with a controlled clock and input script.

### Latency and presentation — R6/R8

Live play waits for native clock synchronization and replicated slot
ownership before reporting readiness. The server offers a common Lightyear tick
anchor and asks each browser for its current native tick. A late offer is
replaced using the measured exchange and the furthest-ahead browser. Negotiation
allows five offers within the loading deadline and all simulations stay at tick
zero until the server commits. The authority dispatches at 30 Hz and checks
overruns on that same native timeline. The embedded authority has no render loop and skips per-tick texture and HUD work. The server keeps the existing slot
authorization, tick and epoch checks, and missing-input policy.
Client intent and server-accepted controls use distinct native input types. Only the
server publishes accepted input, and a short overlapping packet history covers
jitter and delayed delivery. The client uses native fixed ticks for local input and
stages the controls applied by C in Lightyear's input buffers. Confirmation compares
the retained C digests at the corresponding completed authority tick. The
client keeps 25 digest/input and HUD rows for confirmation delivery, separately
from the 12-tick C rollback history.

Network matches render the latest simulated state at 30 FPS, only after a new
simulation step, with no interpolation, extrapolation or visual correction.
The renderer keeps the fixed simulation and input-driven rollback intact.
Rendering controls lock motion smoothing and frame rate for the match and restore
single-player settings afterwards. Other graphics options remain available.

Draws restore the simulation camera, GTE and effect RNG. Replay submits no
frames, mixer starts, texture uploads or external tick notifications. HUD
messages are staged by tick and local slot, rebuilt during replay and shown once
after confirmation. Audible voices keep a stable emitter/attribute identity.
Corrected one-shots still alive at the new head may play once if they were
unheard. Effects that begin and end entirely during replay are skipped.

Lightyear can adjust its clock speed during play. At the 12-tick accepted-input
boundary it pauses the fixed clock and resumes when two ticks of headroom
return. This covers temporary gaps and startup clock lead. A whole-tick clock
resync, excess confirmation backlog, or unsupported gameplay state closes that
client session. The authority and other clients keep running.
The two-player cases verified for portable reconnect also passed rendered
rollback. With the previous Chromium authority, eight rendered clients passed baseline and 30-second combat native
rollback at 72±12 ms, followed by seven-player disconnect survival on
Construction Yard. A two-minute four-player combat run also covers projectile
impacts, freeze, damage and object lifecycles. Eight-player sustained capacity is
still unverified; earlier debug networking Wasm runs exceeded the unchanged
250 ms authority scheduling limit. These capacity results have not yet been
repeated against the embedded host.
Two-player Chromium checks passed at 72±12 and
100±30 ms receive conditioning. With the clock pause enabled, a foreground
Playwright WebKit client reached the boundary at 170±65 ms and resumed after the
artificial delay was removed. Safari itself remains unverified. Smooth high-rate
network presentation is deferred. Mixed Minion/Super Auger combat on Oil Rig
checks freeze interrupting a grab, helicopter destruction and a car death.
Minion/Crusher on Carnival also covers grab interruption, coaster collision and
a death. Other mixed roster/map combinations remain unverified.

### Session identity and modes — R1/R2/R7

The experiment remains a single fixed Deathmatch, epoch 1, a fixed seed and no bots.
For a supported portable roster, the server assigns each participant a random
bearer credential. The match page retains it for the tab session. Reloading the
tab can reclaim only the corresponding disconnected slot while the match is
active and the local build and content match. Live connections retain control
and departed cars follow the existing missing-input policy.
Any nonzero `next_mode` is treated as session completion. A second direct C
initialization works, but this does not establish a second server-managed match.
Tournament's seed order has been fixed at the common initialization point; its
configuration, capacity and gameplay have not been verified in this path. HUD/audio
ownership is patched, but per-slot audible/message presentation still needs explicit
visual/audio acceptance, beyond controls and camera attachment.

Public authenticated admission, TLS and resource-server deployment separation remain
unimplemented. The development file server binds loopback and the match server has
no resource routes. Generated sites contain port code/Wasm/CSS only; local game files
remain separately supplied. The journal contains startup resource names and
fingerprints, accepted controls, outcomes and checksums.

## Running focused checks

Build `bun run build:diagnostic`, then serve `bun run dev:diagnostic --port 18180`
with separately configured local files. Run `bun tests/browser/check_local_checkpoint.cjs`
against that site to test same-instance rollback without a match server. For the
native probe, run `cargo run --manifest-path network/Cargo.toml --features rollback_probe
--example rollback_peer -- 19326` and then `bun tests/browser/check_lightyear_rollback.cjs`.
Set `TM4_ROLLBACK_ENDPOINT` if using a different loopback port.
To play a rendered match, start the site with your local disc and run
`TM4_WEB_URL=http://127.0.0.1:18180/ bun run match 2`.
Set `TM4_MATCH_CARS='Microblast,Pizza Boy'` to choose stock cars by name or
`TM4_MATCH_WORLD='The Oil Rig'` to select a verified map.
Open the printed match link in two browser windows. An empty lobby waits for
the first player. After someone joins, the other players have five minutes to
arrive. Start a new match server after the match has been played. The test
`bun tests/browser/check_live_rollback.cjs` uses a fresh
embedded Rust match server. Supply its endpoint; the browser reference consumes
accepted Frame records only and never sends simulation results to the server. It conditions client receive traffic
at 72±12 ms by default and uses real keyboard input in both rendered clients.
Run `bun tests/browser/check_prediction_start.cjs` with a fresh server to
exercise replacement of a delayed offer. Run `bun tests/browser/check_manual_match.cjs`
with a fresh server to exercise the embedded authority and both clients' default
render settings. Set `TM4_MANUAL_BROWSER=webkit` for Playwright WebKit
and `TM4_MANUAL_WINDOW_WAIT=1` to exercise pause and resume at the bound. Set `TM4_CLOCK_FREEZE_MS=700` to
suspend the receiving tab during the first offer. The standalone rendered browser check
`bun tests/browser/check_rollback_audio.cjs` uses the real mixer to check finite
sounds and an ongoing loop across repeated C restores. Set `TM4_LIVE_DELAY_MS` and `TM4_LIVE_JITTER_MS` to try other profiles. Set
`TM4_LIVE_SCREENSHOT_DIR` to save compositor screenshots.

Run `bun tests/browser/check_portable_checkpoint.cjs` against the diagnostic
site. Set `TM4_PORTABLE_PLAYERS` to 2–8 for participant-root coverage.
Set `TM4_PORTABLE_SCENERY=1` for destroyed scenery or
`TM4_PORTABLE_EXTENDERS=1` for a cross-owner reference rejection and retry.
On Road Rage, use `TM4_PORTABLE_SCENERY=1` with
`TM4_PORTABLE_TRIGGERS=jumppad,teleporter` to replay both map interactions.
Set `TM4_TEST_CAR` to a stock car name to select it in the combat fixture.
For the helicopter test, set `TM4_TEST_WORLD='The Oil Rig'`, optionally with
`TM4_PORTABLE_OIL_DESTROYED=1` to capture after the destruction and debris.
Run `node tests/browser/check_snapshot_reconnect.cjs` with a fresh embedded
server's endpoint. Set `TM4_MATCH_PLAYERS` to match its roster size and
`TM4_RESUME_SLOT` to the zero-based participant to reconnect. Set
`TM4_RESUME_COMBAT=1` to exercise a second native rollback through the imported
warmup interval while other players fire and a survivor changes real steering
input. `TM4_RESUME_ALL_CONDITIONED=1` applies 72±12 ms receive conditioning to every
client. `TM4_RESUME_RETRY_CYCLES=2` repeats interrupted/corrupt attempts.
`TM4_RESUME_OFFER_HOLD_MS=400` deliberately ages the first handoff offer;
combine `TM4_RESUME_HOLD_OFFERS=3 TM4_RESUME_EXPECT_EXHAUSTION=1` to exhaust its
retarget budget, then verify a fresh retry. Set `TM4_RESUME_TEST_TICKS=3600` for a
two-minute live prelude or `TM4_RESUME_EXACT_WINDOW=1` to test handoff at the
12-tick prediction limit.

`node tests/browser/check_network_rosters.cjs` exercises rendered rosters with
`TM4_MATCH_PLAYERS`, `TM4_LIVE_DELAY_MS`, `TM4_LIVE_JITTER_MS` and
`TM4_ROSTER_TICKS`. Set `TM4_ROSTER_COMBAT=1` for sustained firing and
`TM4_MIXED_COMBAT=1` with `TM4_MATCH_CARS='Minion,Super Auger'` and
`TM4_MATCH_WORLD='The Oil Rig'` for the grab interruption fixture, or
`TM4_MATCH_CARS='Minion,Crusher'` and `TM4_MATCH_WORLD='The Carnival'`.
Start its diagnostic server with `TM4_TEST_ACTIONS` pointing to the same local
file as the fixture. Placement actions are applied at the same ticks in the
embedded authority, independent browser reference and clients; real keyboard
commands still travel through native input acceptance and rollback. Browser RSS
includes GPU/renderer processes, separate from checkpoint bytes and Wasm memory.
The reported accepted-tick rate measures the received authority frontier.

Start a fresh match server for each network test with
`TM4_MATCH_LISTEN=127.0.0.1:18182`, the matching `TM4_SITE_DIR`,
`TM4_SIMULATION_WASM`, and private `TM4_RESOURCE_DIR`. Supply
`TM4_MATCH_ENDPOINT=ws://127.0.0.1:18182` and
`TM4_WEB_URL=http://127.0.0.1:18180/` to the browser fixtures. Run

`bun tests/browser/check_network_admission.cjs` for unknown-map refusal, or set
`TM4_ADMISSION_SCENARIO=roster` on a fresh server for the car callback refusal.
`bun tests/browser/check_network_replay.cjs` runs direct replay diagnostics without
a match server.

The server writes to `build/network-journals` by default. Set `TM4_JOURNAL_DIR`
to choose a separate directory. The server binary accepts
`--inspect-journal <path>` to validate a file and report a finished, aborted or
incomplete verified prefix and the first unsupported tick, if present. It flushes rows at least once every 30 ticks and
syncs a finalized file. Retained files are managed by the operator.

Ordinary `build:dev` uses release optimization and excludes test hooks, retaining
only local-disc autoload. `build:diagnostic` owns fixtures and Debug output in
`build/diagnostic/site`. For multi-browser load measurements, reconfigure that
same cache with `-DCMAKE_BUILD_TYPE=RelWithDebInfo` and
`-DCMAKE_C_FLAGS_RELWITHDEBINFO="-O2 -g"` (and the same CXX flags), retaining
assertions, and use the release Rust/Wasm client from the existing network cache.
Debug networking and rendering can overload the local host even when individual
C steps remain fast.
Public `build` also excludes hooks and local autoload.
Generated logs stay under the checkout's ignored `build/` directory.

## Embedded simulation and local checks

`bun run build:dev` also builds `build/dev/authority/site/tm4_standalone.wasm`.
Its hash is bound to the browser build in `simulation-build.json`. Before opening
the lobby, Rust checks that binding and verifies stock MR/IMG/VAB resources against
the repository reference. It computes the same gameplay-content fingerprint as the
browser. Original resources remain separately supplied and are never served by the
match process. Its WASI capability is a read-only preopen named `/DATA`.

```sh
bun tools/headless/prepare-resources.ts "$TM4_DISC_DIR" build/resources
bun run build:dev
TM4_WEB_URL=http://127.0.0.1:18180/ bun run match 2
```

The normal match command launches only the Rust server. `TM4_SITE_DIR`,
`TM4_SIMULATION_WASM`, and `TM4_RESOURCE_DIR` override its default local paths.
Existing `TM4_MATCH_CARS` and `TM4_MATCH_WORLD` choose stock roster/map identities.
The standalone C API exposes catalog, match setup, per-slot commands, stepping,
round/subsystem state, canonical bytes, local checkpoints, portable capture/restore,
and teardown. Portable reconnect still uses the existing session format/capability
limits; it is not a promise that every participant count can reconnect.

Only explicitly annotated `WEB_BROWSER_REPORT` calls are omitted: outgoing UI/catalog/
session publications and diagnostic poses/counters. Required JavaScript reads,
resource delivery, C-memory transfers, presentation clocks and schedulers fail with
an operation and source location. Gameplay time remains `MainFrameCount`; Rust owns
host performance timing. A Wasmtime epoch deadline bounds initialization to the existing 45-second loading budget and live C calls to the
previous three-second simulator deadline; the 250 ms timeline-overrun limit remains.

The maintained checks use the production Rust adapter and Cargo.lock, with no Python
or Node host dependency. A diagnostic browser reference remains only as an independent
test oracle and is never connected as the server simulator:

```sh
bun run build:diagnostic
TM4_WEB_URL=http://127.0.0.1:18180/ bun run test:simulation:record
bun run test:simulation
```

The recording stores exact accepted commands/fixture actions and complete canonical
bytes. Rust compares each tick, replays three times from a checkpoint containing a
live projectile, and transfers a portable snapshot between distinct instances.
Nine negative probes require missing host capabilities to fail explicitly. Private
resources and generated recordings/results stay under ignored `build/` paths. Browser
client, presentation, Lightyear rollback and reconnect tests retain their own coverage.

For synchronized live combat fixtures, explicitly use the diagnostic server build:
`TM4_TEST_ACTIONS=build/live-actions.json bun run match 2 --diagnostic`, with the same
absolute or checkout-relative `TM4_TEST_ACTIONS` path passed to `check_network.cjs` or
`check_live_rollback.cjs`. This local file contains only stock selections and scheduled
fixture calls. The Rust `rollback_probe` feature and diagnostic C exports are both
required; the ordinary server rejects the setting. It creates no debug socket or
remote control protocol. The live fixture's independent browser C oracle replays
accepted client Frame records and compares digests. It never acts as an authority,
returns Ready/Completed messages, or gates server progress. Prediction timing checks
compare local prediction with subsequent accepted-frame reference playback; server
capacity is measured separately from this additional test-oracle workload.
