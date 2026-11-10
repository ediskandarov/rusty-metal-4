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
live. **C-world state replication, rollback, prediction and presentation interpolation
are not implemented.** Installing their plugins does not satisfy R5, R6 or the full
R8 integration proof.

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
  under original game rules. Survivors continue. A client whose summaries diverge
  stops locally; it still cannot recover. Finished/error paths release C resources,
  input queues and callbacks, permitting another direct initialization in the page.
- Diagnostic limits include loopback-only listening, 16 KiB WebSocket messages,
  bounded write buffering, 128 unacknowledged session messages, 13 links, 120 session messages/second/link, 128 received
  bridge messages, 90 ticks without client progress, ten seconds for unidentified
  connections, 45 seconds for loading and five minutes for a lobby. These are local
  experiment safeguards, not proof against hostile public traffic; native-input
  amplification and all library-internal queue limits still need adversarial review.

[Direct-startup checks](../tests/browser/check_network_startup.cjs) cover zero presented
frames, 60 accepted steps repeated after stop/start, all eight control slots, a missing
resource followed by retry, stale/incomplete tick rejection and blocked local cheats.
Equality here covers the published summary/car diagnostics, not the complete world.

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
250 ms RTT, prediction-response or snapshot-recovery acceptance.
`TM4_TEST_MISMATCH=1` verifies that incompatible content is rejected before C initialization.

[Rendered gameplay checks](../tests/browser/check_network.cjs) exercise nonzero-slot
control, car contact, weapon damage, a lethal hit, scoring, round completion and
same-page C reinitialization.
The diagnostic fixture places cars and adjusts target health identically in each
instance. It is controlled gameplay evidence, not arbitrary-world determinism.

## Remaining blockers

### Complete C state and recovery — R4/R5

The digest still samples RNG/positions/health and the mode result. It is not a
canonical full-state checksum. No authoritative checkpoint, capture/restore API,
subsystem divergence diagnosis, correction or reconnect snapshot exists.

A safe state codec cannot copy `Car` or the process heap. `Car` mixes physics and
ammunition with resource pointers, collision-history allocations, weapon arrays,
special-attack callback contexts and callbacks. Object headers carry ownership,
creation serials, process/destruction ordering and spatial interaction links.
World mechanisms and special attacks also keep overlay globals. `SoundProcess`
reads SPU key/envelope status to reallocate voices and destroy emitter objects, while
local listener choice changes voice assignment. A silent authority and an audible
client therefore need an explicit deterministic sound-object lifetime policy; matching
car summaries do not establish audio-independent complete state. Restoring only
Bevy components, or only car transforms, leaves these causal dependencies unchanged.
An unfiltered memory dump would additionally expose locally supplied resource bytes.

Relevant definitions: [Car](../game/include/tm4/modules/car.h),
[object headers/lists](../game/include/tm4/main/object.h),
[object lifetime state](../game/src/main/object/private.h).

### Latency and presentation — R6/R8

Clients currently execute authoritative inputs after receipt. There is no immediate
local prediction, C rollback/replay, correction smoothing, remote interpolation or
stable replay-event identity. Slow clients exceeding retained history stop; they
cannot resynchronize. The existing offline render interpolation is not wired to the
network path. WebTransport has not been evaluated; WebSocket remains susceptible to
head-of-line blocking. The required discrepancy → C restore/replay → smooth display
integration proof therefore remains outstanding.

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
remain separately supplied. No network snapshot format or resource-byte transfer has
been introduced.

## Running focused checks

Build `bun run build:diagnostic`, then serve `bun run dev:diagnostic --port 18180`
with separately configured local files. Start a fresh match server for each test
using `TM4_MATCH_LISTEN=127.0.0.1:18182`, a diagnostic `TM4_AUTHORITY_TOKEN`, and player
count 2 or 8. Set the same token, `TM4_MATCH_ENDPOINT=ws://127.0.0.1:18182` and
`TM4_WEB_URL=http://127.0.0.1:18180/` when running the browser checks with Bun;
`TM4_TEST_PLAYERS=8` selects the eight-client fault test. Chrome is required.

Ordinary `build:dev` uses release optimization and excludes test hooks, retaining
only local-disc autoload. `build:diagnostic` owns fixtures and Debug output in
`build/diagnostic/site`. Public `build` also excludes hooks and local autoload.
Generated logs stay under the checkout's ignored `build/` directory.
