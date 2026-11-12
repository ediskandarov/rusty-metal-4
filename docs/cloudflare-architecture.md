# Cloudflare multiplayer architecture

Standalone GitHub Pages play and the local Rust server remain supported.

## Components

```mermaid
flowchart TD
    Browser["Browser: project site + game"] --> Static["Shared static assets"]
    Browser --> Worker["Worker: API, authentication, routing"]
    Worker --> Directory["Directory Durable Object<br/>Public lobby summaries"]
    Worker --> Lobby["Lobby Durable Object<br/>One per lobby ID"]
    Lobby --> State["Durable storage<br/>Members, settings, phase, deadlines"]
    Lobby --> Container["On-demand container<br/>One active match per lobby"]
    Container --> Rust["Rust + Lightyear + Wasmtime<br/>Authoritative 30 Hz simulation"]
```

| Owner | Authority |
| --- | --- |
| Directory | Discoverability; never grants a player slot |
| Lobby | Membership, host, readiness, settings, admission, container lifecycle |
| Rust | Match simulation, accepted input, rollback protocol, reconnect state, results |
| Cloudflare | Placement, object activation/hibernation and container execution |

The directory is an expiring index, not a second source of membership state.
Joining always checks the lobby. Catalog reads never start a container.

## Lobby lifecycle

```mermaid
stateDiagram-v2
    [*] --> Waiting: Create lobby
    Waiting --> Preparing: Host starts / reserve capacity and freeze roster
    Preparing --> Playing: Resources validated and clients ready
    Preparing --> Waiting: Failure or timeout / stop container and unlock roster
    Playing --> Waiting: Results / stop container and reset readiness
    Playing --> Waiting: Container failure / report interrupted match
    Waiting --> EmptyGrace: Last member leaves
    Preparing --> EmptyGrace: Last member leaves / cancel preparation
    Playing --> EmptyGrace: All participants disconnect
    EmptyGrace --> Waiting: Return to an unstarted lobby
    EmptyGrace --> Playing: Match participant reconnects before deadline
    EmptyGrace --> Closing: Deadline expires
    Closing --> [*]: Stop container, remove listing, clear stored state
```

- Waiting: no container; lobby WebSockets use hibernation.
- Playing: roster is fixed; only existing participants may reconnect.
- Empty-match grace retains the running match for reconnects. Proposed grace:
  120 seconds, configurable. Its expiry ends the match, not merely its visibility.
- A lobby alarm checks persisted deadlines and current membership before cleanup.
  Returning players invalidate the old deadline.
- Host departure in Waiting transfers ownership to a remaining member.
- Match results return remaining members to the same lobby; a new match gets a
  new session ID and fresh container process.

## Starting a match

```mermaid
sequenceDiagram
    participant H as Host browser
    participant L as Lobby DO
    participant C as Rust container
    participant P as Player browsers
    H->>L: Start match
    L->>L: Check host, readiness and quota, freeze roster
    L->>C: Start selected image and wait for readiness
    H->>L: Upload required resources with scoped authorization
    L->>C: Stream private resource upload
    C-->>L: Validated content and build identity
    L->>C: Immutable session configuration and roster
    L-->>P: Session endpoint and scoped join credentials
    P->>L: Connect using own compatible local resources
    L->>C: Forward game WebSockets
    C-->>P: Lightyear start synchronization
    Note over P,C: Gameplay remains in Lightyear, DO does not interpret ticks
    C-->>L: Match finished and results
    L-->>P: Return to lobby
    L->>C: Stop and release resources
```

The host uploads only to the private simulation setup endpoint. Each client reads
its own disc locally. No game assets are included in the container image, public
static assets or player downloads. Stream uploads without buffering whole images
in the Durable Object. After container removal, the next match needs a fresh
upload; persistent resource caching is outside this first version.

## Releasing resources

```mermaid
sequenceDiagram
    participant P as Players
    participant L as Lobby DO
    participant A as Durable alarm
    participant C as Container
    participant D as Directory
    P-->>L: Last connection leaves or expires
    L->>L: Persist empty deadline and session identity
    L->>A: Schedule deadline
    A->>L: Wake
    L->>L: Recheck deadline, membership and session
    alt Still empty and deadline expired
        L->>L: Mark closing, reject new admission
        L->>C: Graceful stop, then bounded forced stop if necessary
        L->>D: Remove listing
        L->>L: Clear lobby data and alarm
    else Member returned or session changed
        L->>L: Ignore obsolete cleanup
    end
```

Cleanup and start requests must be idempotent. Late results, reconnect credentials
and exit notifications are scoped to the session ID. Directory entries expire if
cleanup cannot notify it. Container inactivity timeout is a fallback, not the
membership policy: status polling must not keep an empty match alive indefinitely.

## Resource policy

- Candidate container: **0.25 vCPU, 256 MiB RAM, 2 GB disk**. Validate on Cloudflare;
  increase CPU if the eight-player workload cannot sustain 30 TPS.
- Bound active containers globally, lobby creation per user, preparation time,
  upload size and empty grace. Reserve capacity before startup; release on every
  failure/exit path. Connected but unready users must not hold preparation forever.
- Keep simulation traffic out of durable storage. Persist lobby transitions, not
  per-tick input or positions. Enable hibernation only where eligible; active game
  proxy connections may keep the object awake.
- Container files are temporary. Durable lobby metadata survives a restart;
  running match recovery after container loss is not promised in this version.
- Resource measurements and sizing limitations: [server capacity](server-capacity.md).

## Transport constraint

Cloudflare Containers use **WebSocket** for game connections in this architecture.
Lightyear 0.30.1 supports WebTransport, but the Worker/Durable Object ingress path
currently does not support incoming WebTransport sessions (checked 2026-11-12).
Enabling the Lightyear feature alone does not remove this hosting limitation.

To use WebTransport, keep the site and lobby on Cloudflare and host match servers
on infrastructure with public UDP/QUIC ingress. Browsers connect directly to those
servers; the lobby returns their endpoints and scoped admission credentials.

References: [Lightyear WebTransport](https://docs.rs/lightyear/0.30.1/lightyear/webtransport/server/index.html),
[Cloudflare support discussion](https://github.com/cloudflare/workerd/discussions/6454).

## Implementation boundary

The current Rust launcher owns lobby setup and requires a process restart after
one match. Cloud hosting needs a session-configuration/admission interface and
completion notification; the cloud lobby must not duplicate Rust's editable roster.
The local launcher can supply the same session configuration without Cloudflare.
Public endpoint routing and container-accessible listen addresses also need adapting.

Cloudflare references: [container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/),
[WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
