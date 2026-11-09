# Network implementation audit

Reviewed 2026-11-09: the uncommitted networking prototype on top of `8d19d7b`.
This audit covers the Rust server, browser client, trusted simulator, and C game adapter.
P1 means a prerequisite for reliable, responsive online play; P2 means a lifecycle or
integration issue to resolve before expanding the supported scenarios. Some findings
are deliberate prototype limitations rather than regressions.

## Assessment

The implementation is a useful foundation for other existing game modes. It feeds
network input into ordinary player slots and reuses the game's physics, weapons,
collisions, and scoring. Those boundaries should remain.

It is not yet a general multiplayer layer: input history, state recovery, latency
handling, and session transitions need work before adding modes. Eight connected
players demonstrate slot capacity, not robustness under real network conditions.

## Current architecture

1. Each browser sends changes to its controller state.
2. The Rust server assigns slots and selects the latest input for each simulation tick.
3. A server-owned headless Chromium instance runs the existing C/Wasm game and reports
   the result. An authority token distinguishes it from player connections.
4. The server broadcasts accepted inputs, a result summary, and a state digest.
5. Clients replay the inputs through their own simulation and compare the summary.

The server targets 30 Hz and permits one outstanding simulator step. It waits for the
simulator, but does not wait for every client to execute each tick. Simulator stalls
can therefore slow the match; clients can independently fall behind.

The authoritative game runs in [authority.ts](../tools/network/authority.ts), not in
Rust. This preserves the original rules without implementing a second physics engine.
Headless Chromium is a practical experimental host; a browser-independent simulation
interface would make its lifecycle easier to control later.

Only `lightyear_link` and `lightyear_websocket` are connected in
[Cargo.toml](../network/Cargo.toml). Input scheduling, the protocol, and result checking
are custom. Lightyear's higher-level prediction, replication, and interpolation are
not connected to the C world. They require an explicit integration; installing the
transport does not enable them. See the [Lightyear project](https://github.com/cBournhonesque/lightyear#features).

## Findings

### N1 — P1: button transitions can disappear

**Evidence:** `Match::request` overwrites `player.input` for each newer sequence number.
The next tick samples only that final value. A press followed by a release before
sampling becomes indistinguishable from no press. Sequence numbers order messages;
they do not assign commands to simulation ticks.

A loopback probe against the existing server reproduced this: the press and release
were accepted, but both adjacent tick inputs contained an unpressed button.

**Impact:** network delays or batched delivery can lose firing, weapon selection, and
confirmation actions even when the transport delivers every message.

**Required direction:** retain tick-indexed input history and define how discrete
button transitions are preserved and acknowledged. A newer held-button state must
not silently erase an unconsumed action.

Source: [server input handling](../network/src/main.rs#L179),
[client input sender](../web/src/network/match.ts#L65).

### N2 — P1: state divergence is only partially detected and cannot be repaired

**Evidence:** `match_digest` hashes one RNG state, car presence, positions, and health.
It omits velocity, orientation, ammunition, projectiles, timers, world state, and the
other RNG state. Equal digests do not establish equal simulations. `Frame` contains
inputs and a summary, not a restorable world snapshot.

When a checked value differs, the client cancels its game and closes the connection.
The server then terminates the match for the other participants.

**Impact:** some discrepancies remain undetected until they affect a checked value;
any detected discrepancy ends play instead of correcting the affected client.

**Required direction:** define the complete gameplay state needed for a reproducible
step, add useful divergence diagnostics, and support authoritative capture/restore.
Prediction and reconnect should use this same state contract. A checksum is a
consistency check, not a replacement for state transfer.

Source: [digest](../port/web/net_match.c#L206),
[wire state](../web/src/network/protocol.ts#L5),
[client divergence handling](../web/src/network/match.ts#L73).

### N3 — P1: participants do not agree on all initial conditions

**Evidence:** `Start` specifies player count, world index, and seed. Each game instance
chooses its own roster by enumerating local resources. There is no handshake for the
simulation build or gameplay content. The loader validates the original executable,
but that does not identify the compiled port or guarantee identical gameplay assets.

`WebApplyCheats` also continues to apply local browser-menu changes during a match.
For example, local ammunition or physics cheats can change one simulation without
changing the authority's simulation.

**Impact:** ordinary configuration or resource differences can cause divergence even
with identical network inputs.

**Required direction:** the authority defines mode, map, roster, rules, seed, and
allowed gameplay modifiers. Validate simulation/content compatibility before play;
cosmetic assets need not be identical. Keep presentation preferences local and route
any permitted gameplay changes through the authoritative tick stream.

Source: [start message](../network/src/main.rs#L257),
[local setup](../port/web/net_match.c#L35),
[per-frame cheats](../port/web/bootstrap.c#L364),
[loader verification](../web/src/loader/loader.ts#L16).

### N4 — P1: latency and packet arrival timing directly affect play

**Evidence:** a client changes its simulated world only after receiving a completed
server frame. There is no local input prediction. The network branch draws after a
simulation tick and bypasses the ordinary interpolation path. It processes one tick
per browser-frame invocation; the client rejects a backlog of 120 pending frames.

**Impact:** control response includes the round trip, server scheduling, and simulator
execution. Jitter becomes uneven movement. Slow or suspended browsers accumulate old
frames, with no snapshot-based recovery. The local render interpolation setting does
not smooth this branch.

**Required direction:** separate simulation, network, and presentation timelines;
add predicted local input with authoritative correction and buffered presentation.
Bound catch-up work and define recovery when a client falls too far behind.

Source: [network frame loop](../port/web/level.c#L282),
[frame queue](../web/src/network/match.ts#L131).

### N5 — P2: participant liveness and reconnection are incomplete

**Evidence:** one player disconnect sets `ended` for the whole match. This was
reproduced with test peers. Server-side readiness has no deadline. An open connection
with no new input retains its last buttons; a probe confirmed reuse across subsequent
ticks, and there is no application-level freshness limit. Since unchanged input is
not sent, silence cannot distinguish a held button from an inactive application.

**Impact:** an interrupted tab can abort everyone or leave stale controls active.
A connected peer that never becomes ready can block startup indefinitely.

**Required direction:** define readiness deadlines, application heartbeats, stale-input
handling, and a disconnect policy. Reconnection needs stable participant identity and
a current authoritative state, rather than a new simulation starting at tick zero.

Source: [disconnect handling](../network/src/main.rs#L219),
[readiness gate](../network/src/main.rs#L268),
[input suppression](../web/src/network/match.ts#L65).

### N6 — P2: local presentation still assumes player slot zero

**Evidence:** `draw_network_view` temporarily replaces slot zero's car and camera for
rendering. `SoundProcess` runs before that substitution and selects listeners from
`GameInfo.player_count`, which is one. Thus positional sound uses the first player's
camera on every client. `ScreenLocalMessageRegisterV` rejects messages addressed to
other slots for the same reason.

**Impact:** a client can see its own car while hearing from another player's position
and missing its own gameplay messages. These are incomplete slot adaptation, separate
from transport correctness.

**Required direction:** explicitly distinguish a gameplay participant from a local
viewport/listener. Apply that mapping to sound, HUD messages, camera preferences, and
other presentation consumers without replacing simulation ownership.

Source: [view substitution](../port/web/level.c#L260),
[sound listener](../game/src/main/sound.c#L804),
[message filtering](../game/src/main/screen.c#L382).

## Extending existing modes

The input-to-slot adapter and trusted game simulation are reusable. The current
Deathmatch setup and lifecycle are not yet generic:

- `WebNetMatchStartPending` fixes Deathmatch, one round, and no bots.
- The protocol's result fields describe Deathmatch wins, losses, and a single winner.
- Any nonzero `next_mode` ends the network session, including a request to play another
  round. The C adapter also disables networking before following that transition.
- The network seed is applied **after** `GamePrepareSession`. That function calls the
  mode reset, and `TournamentReset` already makes random opponent selections. The
  current fixed Deathmatch avoids this selection path; simply switching its mode
  would seed those earlier operations too late.
- Tournament shares a finite car capacity among humans, allies, opponents, and bosses.
  Eight human slots in Deathmatch do not establish support for an unchanged
  eight-human tournament.

Sources: [fixed setup](../port/web/net_match.c#L66),
[server completion](../network/src/main.rs#L187),
[load and seed order](../port/web/level.c#L68),
[mode preparation](../game/src/main/game.c#L643),
[tournament setup](../game/src/main/tournament.c#L117).

Introduce a common session configuration and lifecycle: loading, running, round
transition, map transition, and finished. Keep mode rules in the existing game code;
provide mode-specific setup and outcome adapters. A transport or reconnect operation
should not need to interpret Deathmatch fields.

## Verification boundary and next work

The audit's executable probes used the already-built Rust server with test peers and
a simulated authority. They confirmed lost button transitions, retained input during
silence, and whole-match termination on one disconnect. They did not exercise physics.

The existing [browser integration test](../tests/browser/check_network.cjs) covers
real car contact, weapon damage, scoring, and return to the menu. It positions cars
and adjusts target health identically in each instance. That is a useful controlled
scenario, not proof of arbitrary gameplay determinism or internet-quality behavior.

Priorities:

1. Preserve inputs and agree on authoritative initial conditions.
2. Establish complete simulation state capture/restore and divergence diagnostics.
3. Add latency handling, prediction/correction, and independent presentation.
4. Handle loading failures, disconnects, reconnects, and round/map transitions.
5. Extend modes through their existing rules after those contracts are stable.

Validation should include variable latency, delivery stalls, short button presses,
background tabs, slow clients, incompatible gameplay data, reconnects, and long
matches. Rendering settings must not affect gameplay state. For public deployment,
also review authenticated admission, encrypted transport, message/connection limits,
and backpressure; the current local prototype does not establish those properties.
