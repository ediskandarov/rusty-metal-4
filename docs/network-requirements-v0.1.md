# Network requirements — v0.1

Status: design requirements, not implemented guarantees. Updated 2026-11-09.
Basis: the [network prototype audit](network-audit.md) and the agreed single-player
browser model. The first supported scenario remains 2–8-player Deathmatch.

## Scope and invariants

- One browser controls exactly one participant and has one viewport and one audio
  listener. Local multiplayer and mixed local/network parties are out of scope.
- The authority has no local participant, viewport, or listener. The current
  server-owned Chromium host may remain while the simulation interface is developed.
- Reuse ordinary gameplay slots and existing physics, weapons, damage, scoring, and
  mode rules. Networking must not implement a competing version of these rules.
- The server owns session configuration, slot assignments, simulation time, accepted
  inputs, gameplay outcomes, and transitions. Clients send intentions, not damage,
  scores, positions, or victory claims.
- Simulation advances at 30 fixed steps per second. Rendering frequency is independent.
- Preserve the original game as a pinned dependency. Port-specific adaptations belong
  in the port and its patch series. Removing upstream local multiplayer is unnecessary.
- Other modes retain their existing rules and capacity constraints. Supporting eight
  humans in Deathmatch does not imply eight humans plus bots in Tournament.

## R1. Separate participants, control sources, and presentation

A participant has stable session identity and an assigned gameplay slot. A socket is
replaceable and must not be that identity. A car instance can also change through
respawning without changing participant identity.

The client's local context identifies its participant and current view target.
Camera, HUD, messages, audio, controller preferences, and feedback use that context.
They must not obtain local identity from slot zero or temporarily replace another
participant's car/camera in global gameplay state.

Gameplay APIs distinguish human-car count from local-view count. The server runs with
no presentation context; a browser runs with one. AI remains controlled by the game.
Local device bindings map to the assigned participant regardless of its slot number.
An eliminated participant may keep a view according to existing mode behavior without
acquiring control of another participant.

**Acceptance:** exercise every slot, including 6 and 7. Each sees its own HUD and
messages, hears from its own view, and controls only its assigned car. Running without
rendering or audio produces the same gameplay state for the same accepted input.

## R2. Agree on authoritative initial conditions

Before loading, the server supplies a versioned session description containing:

- Session identity and world/round epoch.
- Simulation build/protocol compatibility and gameplay-content fingerprints.
- Mode and its settings, stable map identity, roster, slot ownership, and AI settings.
- Seeds for all gameplay RNGs and allowed gameplay modifiers.

Choose resources by stable identity rather than local enumeration order. Reject
incompatible gameplay builds/data before simulation starts and explain the mismatch.
Cosmetic differences can be allowed when they do not affect gameplay or allocation
behavior relevant to determinism; missing optional music is not a gameplay mismatch.

Apply seeds before any mode reset, roster selection, constructor, or other gameplay
randomness. A ready client confirms the specific configuration/epoch and completed
initialization, not merely an open socket. Compare initial gameplay state before tick 0.

Local cheats cannot change a running network simulation. If a session permits a
modifier, the server schedules it at an explicit tick for all participants.

**Acceptance:** different menu histories and local preferences produce the same initial
state; incompatible gameplay resources are rejected. Include a mode initialization
that consumes randomness before spawning cars, as Tournament currently does.

### Resource ownership and distribution — agreed

Each participant provides their own game files locally. The authority also uses
separately supplied local resources. Neither multiplayer admission nor direct
simulation startup introduces resource distribution by the game server.

- Public builds and deployment artifacts exclude original disc images, executables,
  archives, models, textures, audio, and movies.
- The network protocol transfers configuration, resource identities/fingerprints,
  accepted inputs, gameplay events and state checksums. It does not upload or download original
  resource files. Missing or incompatible resources produce a local diagnostic, not
  an automatic download from the host or another player.
- Match journals contain gameplay commands, events and stable resource identities.
  Replaying them requires the original local resources and matching simulation build.
- The existing diagnostic file server may read explicitly configured local files and
  serve them on loopback for local development/authority startup. Its `/__dev/` routes
  must not be exposed by the public service, proxy, tunnel, or multiplayer endpoint.
- Resource fingerprints establish compatibility, not proof of ownership or permission
  to redistribute. Do not present the compatibility handshake as such proof.

**Acceptance:** inspect public artifacts, journal files and captured match traffic for
original resource payloads. Public endpoints cannot serve `/__dev/disc.json` or
`/__dev/files/*`; a client without local game files cannot obtain them from the match
server. Direct authority startup does not make its configured files public.

## R3. Preserve and schedule input

Each input record carries session/epoch, sequence, and intended simulation tick.
Participant ownership comes from the authenticated connection, not a trusted payload
field. Define device-to-game input mapping once and share it with prediction.

- Retain bounded input history until acknowledged or explicitly expired.
- Preserve held controls and discrete button transitions. A press/release delivered
  together must not silently become no action; duplicate delivery must not repeat it.
- Define how multiple transitions within a simulation step are sampled or queued.
  Preserve original button semantics rather than inventing a new firing rate.
- Validate values and constrain past/future tick windows and per-client message volume.
- Acknowledge which inputs were processed and which were rejected as late. Specify the
  policy for late input; arrival order alone must not determine an arbitrary tick.
- Use periodic input freshness/heartbeat information even while controls are unchanged.
- Missing input has a bounded policy: limited reuse for held controls, then neutral
  controls. Never synthesize repeated press edges or retain stale fire indefinitely.

**Acceptance:** short presses survive delivery batching; duplicates do not double-fire;
late and out-of-window commands have deterministic outcomes. No connection can control
another slot. Releasing controls during a delivery stall does not leave them stuck
indefinitely after recovery.

## R4. Expose a controllable simulation boundary

The game adapter must support initialization, one fixed step with all accepted inputs,
canonical state checksums, replay from the agreed startup, transition handling, and
shutdown. These are capabilities with no prescribed function names.

### Direct simulation startup — agreed

Provide a direct startup entry point that consumes the authoritative session
configuration from R2 and prepares the game world. It must work without playing
intro movies, opening or navigating menus, creating a local controller, requesting
browser user interaction, or presenting frames. It must not require the current game
mode to be the menu as a prerequisite.

Separate application/platform initialization, resource preparation, and session
initialization. The authority and playing clients use the same gameplay initialization
path. The browser attaches its local presentation separately; the authority needs no
viewport or audio device. Keep internal camera or sound-related state if it affects
gameplay, until that dependency has been explicitly separated and verified.

Startup validates configuration and required resources, resets session-owned state,
applies seeds before gameplay initialization, and constructs the selected world and
participants. It reports loading, ready-at-tick-zero, or a concrete error. Loading must
not secretly advance gameplay ticks. The server starts stepping only after its own
simulation and the required clients are ready for the same configuration and epoch.

Shutdown and failed initialization release session resources and callbacks so that
another match can start in the same process. This does not require a native server
port or removal of the normal browser menu.

**Acceptance:** launch a configured match without synthetic menu key presses or intro
assets; execute recorded inputs; stop and start it again. Compare the initial state
and recorded continuation. Check missing-resource failure followed by a successful
retry. Verify the same startup path on the authority and on a client in a nonzero slot.

### Fixed-step execution

The step must not depend on browser repaint, wall-clock time, local camera settings,
render quality, or arrival timing. Initialize clocks and RNGs explicitly. Order gameplay
objects and events deterministically where iteration order affects results.

The server must not wait for every client's rendering. Bound catch-up work and report
simulator overruns. If the authority cannot sustain the tick rate, use an explicit
pause/failure policy instead of silently presenting slow simulation as healthy 30 Hz.

**Acceptance:** identical initial state and recorded inputs produce identical gameplay
state on the supported browser/authority builds. Test with rendering disabled and at
several render rates. Cross-version or native/Wasm determinism is not assumed.

## R5. Journal and replay the authoritative match

Persist the agreed startup configuration and accepted inputs for the entire active
match, in simulation order. Any additional event that changes gameplay must be
represented at its simulation tick. Record canonical state checksums and subsystem
checksums to verify replay and locate the first disagreement. Use stable resource
and object identities where needed.

Journal replay can rebuild the simulation from tick zero with local resources
and verify its progression while the authority advances. Deliver the journal in
bounded chunks and limit unconfirmed work, memory, storage and stalled connections
explicitly. Match duration and the recovery history are independent of the
15-minute validation benchmark. Reconnect uses a portable checkpoint with a
bounded suffix of the accepted-input journal.

**Acceptance:** replay a sustained combat history including firing, impacts,
collisions and world mechanisms. Verify state equality and measure storage,
replay time and browser responsiveness. A damaged client catches up without
terminating the other players' match.

## R6. Handle latency separately from rendering

Predict local control without waiting for the round trip. Reconcile using authoritative
commands and input acknowledgements. Rebuild and replay when needed. Establish the
collision dependencies of prediction; predicting only one isolated car is insufficient
when it exchanges impulses or damage with other dynamic objects.

Presentation follows its own timeline and interpolates between known states. Keep any
extrapolation bounded and explicit. Smooth visual corrections where appropriate while
retaining the authoritative collision state. Render settings must not change tick rate.

Audio, HUD notifications, and effects need stable event identity and replay policy.
Rollback must not replay the same explosion sound, award a result twice, or duplicate
persistent effects. Distinguish predicted effects from confirmed outcomes.

A slow client uses bounded catch-up. If it cannot make progress, stop that client
without holding the authority or other players.

**Acceptance:** under latency/jitter, local controls respond through prediction and
remote motion remains buffered. Corrections do not duplicate damage or effects.
Measure input response, correction size/frequency, tick lag, and buffered history.

## R7. Manage the whole session lifecycle

Represent lobby, loading, running, transition, and finished states explicitly, with
per-participant loading/connected/reconnecting status. Every waiting phase has a bounded
deadline and an understandable failure message.

A temporary disconnect retains participant identity for a bounded grace period and
applies the agreed missing-input policy. Authenticate reclaiming that participant;
a second connection cannot seize the slot. Restore a current-epoch authority
checkpoint and replay the bounded accepted inputs that follow it before handing
control back. Keep the journal available for match verification and replay.
Reject messages from previous connections or epochs.

A permanent departure is handled through a declared policy compatible with the mode's
existing rules. Do not add an implicit new bot, invulnerability, or respawn rule.
Do not globally abort solely because a transport connection closed. The existing rules
may legitimately finish the round once the departure has been handled.

Distinguish next round/map from session completion. Synchronize loading and initialize
new-world state deterministically. Repeated matches must clear queues, callbacks,
readiness, input history, and published state from the previous session.

**Acceptance:** cover delayed readiness, load failure, client restart, temporary loss,
expired reconnect, duplicate join, map transition, and a second match without reloading
the page. Unaffected participants continue according to the declared policy.

## R8. Keep transport independent of game rules

The target is a full Lightyear client/server integration, including its higher-level
networking facilities. Using only its WebSocket transport and implementing equivalent
synchronization in TypeScript does not satisfy this requirement.

Use the library's facilities for:

- Tick/time synchronization and buffered, tick-indexed player input.
- Typed messages, serialization, and channels with appropriate delivery guarantees.
- Authoritative outcomes, journal delivery and network object identity/lifetime.
- Client prediction, rollback/replay, and reconciliation.
- Presentation interpolation and correction smoothing.
- Bandwidth limits and replication priorities.
- Connection diagnostics and controllable adverse-network testing where supported.

Validate these capabilities against the selected pinned release and its examples.
The prototype pins 0.30.1; documentation for a newer release is not proof that the
same APIs exist in that version. Version changes are a separate implementation decision.
See the [Lightyear feature overview](https://github.com/cBournhonesque/lightyear#features).

This requires a Lightyear runtime on the browser client as well as on the server.
Prove a Rust/Wasm-to-Emscripten bridge with explicit data ownership and scheduling;
do not assume that two Wasm modules share memory, pointers, or an ABI. TypeScript
continues to own browser UI, asset loading, and launch orchestration. C continues to
own game simulation. Bevy systems coordinate the simulation adapter with Lightyear's
network timeline. Avoid implementing the physics engine again in Rust.

For each replicated or predicted piece of state, define its authoritative owner,
its C representation, its network representation, and when it crosses the bridge.
Prevent two independent copies from both acting as authoritative simulation state.
Lightyear rolling back Bevy components is insufficient unless all dependent C state
is restored too. Restoration and replay must obey R4–R6.

Some facilities need explicit applicability decisions rather than blanket activation:

| Facility | Integration constraint |
| --- | --- |
| Interest management | Do not omit objects needed by a client's predicted collisions, projectiles, or replay. Establish simulation dependencies first. |
| Lag compensation | Define the affected weapon/query and time model. Rewinding hitscan targets and rolling back projectile physics are different operations. Preserve declared game rules. |
| Predicted object spawning | Use stable identities and confirm/cancel predictions without duplicating projectiles, damage, or effects. |
| Browser transport | Evaluate WebTransport for gameplay channels and browser support; document the degraded behavior of any WebSocket fallback. |
| Other topologies/backends | P2P, host migration, and platform-specific transports are outside the agreed authoritative-server/browser scope. |

The first integration proof must exercise the actual high-level Lightyear path:
a browser input causes a C simulation step, authoritative state reaches another
browser, an intentionally introduced discrepancy triggers C state restoration/replay,
and the result is presented smoothly without duplicate effects. Merely exchanging
messages between two Lightyear endpoints is insufficient.

Build this capability incrementally, with each feature tested before the next one.
The goal is comprehensive use of relevant library facilities, not enabling every
feature flag regardless of whether it fits the game's simulation model.

Maintain clear boundaries between transport/session orchestration, the C simulation
adapter, and browser presentation. Transport does not interpret Deathmatch fields.
Mode adapters translate existing setup/results into session events; they do not
reimplement scoring, victory, shared lives, or AI decisions.

Validate incoming messages at runtime on both sides. Bound packet sizes, queues,
connection counts, and message rates. A non-reading client must not exhaust server
memory. Protect authority credentials and reconnect credentials. Public operation
requires authenticated admission and encrypted connections; local diagnostics can
retain an explicitly local configuration.

## Delivery and validation

Implement in independently testable stages:

1. R1–R3 and direct startup from R4: correct slot/presentation ownership, identical
   setup, menu-independent session startup, and reliable input history.
2. R4–R5: deterministic stepping and proven state capture/restore.
3. R6: prediction, reconciliation, presentation smoothing, and replay-safe effects.
4. R7–R8: reconnect/transition handling and deployment limits; validate a second existing
   mode without rewriting its rules.

Basic timeouts, bounded queues, and input validation apply from the first stage; the
order above does not defer them until public deployment.

Initial test profiles below are proposed engineering targets, not measured guarantees:

| Scenario | Required observation |
| --- | --- |
| 2 and 8 clients, clean network | Correct slot ownership and consistent outcomes throughout a sustained match |
| 100 ms RTT with variable delay up to 30 ms | No accepted input edges lost; responsive prediction; bounded correction/history |
| 250 ms RTT with variable delay up to 80 ms | Explicit degradation without uncontrolled queues or outcome disagreement |
| 0.5–2 s delivery interruption | Bounded stale input and successful recovery without aborting everyone |
| Hidden tab or client rendering below 30 FPS | Other participants unaffected; bounded catch-up or snapshot recovery |
| Duplicate, stale, malformed, or excessive messages | Rejection/throttling without corrupting the session |
| Different local render/audio settings | Identical gameplay state for the same accepted inputs |
| Round/map transitions and reconnect | Correct epoch, ownership, scores, and restored state |

Exercise both protocol behavior and full gameplay. Include weapons and persistent
special attacks, car collisions, pickups, deaths, map mechanisms, and mode transitions.
Use controllable transport faults; for WebSocket, distinguish delayed application
messages from actual connection failure and transport retransmission stalls.

Record RTT, jitter, input age, simulation overruns, client tick lag, corrections,
resyncs, and queue sizes. These observations should explain a failure without full
per-frame logs. Do not claim completion from a single same-machine duel or matching
position/health checksums.
