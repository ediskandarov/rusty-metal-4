# Network implementation audit

Updated 2026-11-10 for the experimental networking implementation.
The [v0.1 requirements](network-requirements-v0.1.md) remain the acceptance contract;
this page records actual coverage and limitations, not revised requirements.

## Current boundary

C owns gameplay, including physics, weapons and scoring. A server-owned Chromium
instance runs that C/Wasm simulation. The native Rust server selects accepted inputs
and advances it on a 30 Hz schedule, with one outstanding step. A delay over 250 ms
fails the session explicitly instead of silently slowing the schedule. Clients do
not gate the authority's simulation after initial readiness.

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
live. Recovery streams the authoritative match journal to rebuild the C world.
Live matches can opt into native Lightyear prediction for the stock Construction
Yard Deathmatch. The diagnostic build also includes a smaller native rollback probe.
Portable C state replication remains open.

Sources: [Rust protocol](../network/src/protocol.rs),
[browser runtime](../network/src/browser.rs), [JS ownership bridge](../web/src/network/transport.ts),
[authority adapter](../tools/network/authority.ts).

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
- Compatibility includes protocol version, both Wasm build hashes, and hashes of
  locally supplied gameplay archives/images/sound banks. Optional music/movies and
  menu files are excluded. Fingerprints are compatibility checks only. Roster and
  map selection use names supplied by the authority; local exposed cheats are blocked.
- Render/device samples with unchanged buttons coalesce at the native input boundary;
  newer held state stays separate from an older button edge. Superseded unsent
  sequences leave JS acknowledgement history immediately. Input transitions retain
  sequence and intended tick. Multiple transitions aimed
  at one tick occupy successive ticks, preserving normal press/release semantics.
  History is bounded to 60 records, future acceptance to 60 ticks, and held input
  reuse to nine ticks. Frames acknowledge processed sequences; late/future/full
  requests are explicitly rejected. Lightyear retransmissions are deduplicated.
- A departed client loses queued controls immediately; its car remains in combat
  under original game rules. Survivors continue. Finished/error paths release C resources,
  input queues and callbacks, permitting another direct initialization in the page.
- The server journals startup identity, accepted controls, per-tick checksums and
  mode transitions to an append-only file. Inputs are the only externally
  scheduled gameplay commands in the current mode. The first 8 MiB of packed
  rows are cached in memory. Additional rows are read from disk during replay.
  A 1 GiB worst-case per-match disk budget ends the match explicitly if reached.
- Construction Yard recovery offers one attempt per client. It validates the
  journal header and each ordered block, verifies every replayed tick and returns
  to live inputs only after reaching the authority's head. At most four blocks
  of up to 64 ticks are in flight per recovering client. Replay yields between
  batches, and missing progress disconnects only the recovering client.
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

[Network timing checks](../tests/browser/check_network_timing.cjs) verify 30 Hz simulation
and performance counters while clients alternate between 30 FPS and display-rate rendering.
The authority runs without animation callbacks or presented frames.

[High-rate input checks](../tests/browser/check_network_analog.cjs) feed changing analog
samples through the production browser callback at 120 Hz for 30 seconds, alongside
batched press/release events. They check bounded JS/native history and actual C inputs.

[Fault checks](../tests/browser/check_network_faults.cjs) run the real browser/Rust/C
path with two and eight clients. They cover a batched press/release plus duplicate,
late/future rejection, nine-tick stale expiry, Lightyear receive-side delay of
100±30 ms, a 1.2-second frozen client, bounded catch-up and disconnect survival.
The conditioner acts on received Lightyear packets; it does not emulate TCP loss
or WebSocket head-of-line retransmission. These short runs are not sustained-match,
250 ms RTT or prediction-response acceptance.
`TM4_TEST_MISMATCH=1` verifies that incompatible content is rejected before C initialization.

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
simulation. The wire test perturbs only one client's energy and uses ordinary
accepted controls for recovery. The sustained and stalled wire cases exercise
full-history catch-up and progress-based cancellation. The sustained two-client
check accelerates 15 minutes of combat, then measures recovery with the authority
back at live 30 Hz. The disk tests exercise an eight-slot history of the same
length, forced cache spill, corrupt records and incomplete files.

Recovery uses the current match's startup and journal. Constructors run again
using local files. Unknown object classes, unknown timer callbacks, opaque car
callbacks, independent Wasm modules and other maps cannot use recovery. Portable
state snapshots and reconnect admission remain open.

### Same-instance C checkpoint

An opt-in headless Construction Yard Deathmatch can retain a same-instance checkpoint.
Capture requires a completed simulation tick with no staged input. Restore rewinds
the same running instance, then the ordinary C step accepts recorded controls.
During replay the headless instance suppresses external tick publication, audio
playback, rumble and presentation. Finishing replay re-enables tick publication.
Ordinary matches use journal recovery on the network.

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
the same allocator and world undo log. Bots, other maps, car packs, independent
Wasm modules and sanitizer builds are outside the checkpoint scope.

[The local checkpoint check](../tests/browser/check_local_checkpoint.cjs) uses
Orbital and Pizza Boy in headless Chromium. It restores tick 80 with a live projectile
and compares the canonical bytes and all five subsystem checksums on each of 180
replayed ticks, three times. Combat exercises steering, contact, weapon damage and
projectile creation, impact and removal. A second case destroys and restores scenery,
including its display and collision state, and checks another 180 ticks. The test
also perturbs car, world and RNG state and hides a startup archive while restoring.

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

The optional live mode waits for native clock synchronization and replicated slot
ownership before reporting readiness. The server offers a common Lightyear tick
anchor and asks each browser for its current native tick. A late offer is
replaced using the measured exchange and the furthest-ahead browser. Negotiation
allows five offers within the loading deadline and all simulations stay at tick
zero until the server commits. The authority dispatches at 30 Hz and checks
overruns on that same native timeline. The authority browser has no render loop
and skips per-tick texture and HUD work. The server keeps the existing slot
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
The server journal still supports ordinary non-predicting match recovery.
Rendered play was verified with Orbital and Pizza Boy. An eight-slot attempt
reached all slot assignments, but the default larger roster used car callbacks
outside checkpoint coverage. Two-player Chromium checks passed at 72±12 and
100±30 ms receive conditioning. With the clock pause enabled, a foreground
Playwright WebKit client reached the boundary at 170±65 ms and resumed after the
artificial delay was removed. Safari itself remains unverified. Smooth high-rate
network presentation is deferred. Covering more maps and rosters remains open.

### Session identity and modes — R1/R2/R7

The experiment remains a single fixed Deathmatch, epoch 1, a fixed seed and no bots.
There is no replaceable authenticated participant identity, reconnect credential,
grace-period resume, map/round transition protocol or generalized mode adapter.
Any nonzero `next_mode` is still treated as session completion. A second direct C
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
To play the experimental rendered match, start the site with your local disc
and run `TM4_NATIVE_PREDICTION=1 TM4_WEB_URL=http://127.0.0.1:18180/ bun run match 2`.
Open the printed match link in two browser windows. An empty lobby waits for
the first player. After someone joins, the other players have five minutes to
arrive. Start a new match server after the match has been played. The test
`bun tests/browser/check_live_rollback.cjs` uses a fresh prediction-enabled
match server and launches its own Chromium authority. Supply the endpoint and
authority token as for the journal tests. It conditions client receive traffic
at 72±12 ms by default and uses real keyboard input in both rendered clients.
Run `bun tests/browser/check_prediction_start.cjs` with a fresh server to
exercise replacement of a delayed offer. Run `bun tests/browser/check_manual_match.cjs`
with a fresh server to exercise the production authority command and both clients'
default render settings. Set `TM4_MANUAL_BROWSER=webkit` for Playwright WebKit
and `TM4_MANUAL_WINDOW_WAIT=1` to exercise pause and resume at the bound. Set `TM4_CLOCK_FREEZE_MS=700` to
suspend the receiving tab during the first offer. The standalone rendered browser check
`bun tests/browser/check_rollback_audio.cjs` uses the real mixer to check finite
sounds and an ongoing loop across repeated C restores. Set `TM4_LIVE_DELAY_MS` and `TM4_LIVE_JITTER_MS` to try other profiles. Set
`TM4_LIVE_SCREENSHOT_DIR` to save compositor screenshots.

Start a fresh match server for each network test using `TM4_MATCH_LISTEN=127.0.0.1:18182`, a diagnostic `TM4_AUTHORITY_TOKEN`, and player
count 2 or 8. Set the same token, `TM4_MATCH_ENDPOINT=ws://127.0.0.1:18182` and
`TM4_WEB_URL=http://127.0.0.1:18180/` when running the browser checks with Bun;
`TM4_TEST_PLAYERS=8` selects the eight-client fault test. Run
`bun tests/browser/check_network_replay.cjs` for direct and wire replay verification.
It runs only the direct portion when no match endpoint and token are supplied.
Use a fresh server for each `TM4_REPLAY_SCENARIO` value. Set
`TM4_REPLAY_NETWORK_ONLY=1` for the `stalled` or `long` case and set
`TM4_REPLAY_PLAYERS` to the server's player count. A debug server launched with
`TM4_TEST_FAST_UNTIL=27000` advances the first 15 simulated minutes without
wall-clock pacing, then resumes 30 Hz before recovery. Chrome is required.

The server writes to `build/network-journals` by default. Set `TM4_JOURNAL_DIR`
to choose a separate directory. The server binary accepts
`--inspect-journal <path>` to validate a file and report a finished, aborted or
incomplete verified prefix and the first unsupported tick, if present. It flushes rows at least once every 30 ticks and
syncs a finalized file. Retained files are managed by the operator.

Ordinary `build:dev` uses release optimization and excludes test hooks, retaining
only local-disc autoload. `build:diagnostic` owns fixtures and Debug output in
`build/diagnostic/site`. Public `build` also excludes hooks and local autoload.
Generated logs stay under the checkout's ignored `build/` directory.
