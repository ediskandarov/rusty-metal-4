# Cloudflare multiplayer architecture

Standalone GitHub Pages play and the local Rust server remain supported.

## Components

```mermaid
flowchart TD
    Browser["Browser: project site + game"] --> Static["Shared static assets"]
    Browser --> Worker["Worker: API, authentication, routing"]
    Worker --> Directory["Directory Durable Object<br/>Public room summaries"]
    Worker --> Room["Room Durable Object<br/>One per room ID"]
    Room --> State["Durable storage<br/>Members, settings, phase, deadlines"]
    Room --> Container["On-demand container<br/>One active match per room"]
    Container --> Rust["Rust + Lightyear + Wasmtime<br/>Authoritative 30 Hz simulation"]
```

| Owner | Authority |
| --- | --- |
| Directory | Discoverability; never grants a player slot |
| Room | Membership, host, readiness, settings, admission, container lifecycle |
| Rust | Match simulation, accepted input, rollback protocol, reconnect state, results |
| Cloudflare | Placement, object activation/hibernation and container execution |

The directory is an expiring index, not a second source of membership state.
Joining always checks the room. Catalog reads never start a container.

## Room lifecycle

```mermaid
stateDiagram-v2
    [*] --> Waiting: Create room
    Waiting --> Preparing: Host prepares / reserve capacity
    Preparing --> Playing: Resources validated / host starts ready roster
    Preparing --> Waiting: Failure or timeout / stop container and unlock roster
    Playing --> Waiting: Results / stop container and reset readiness
    Playing --> Waiting: Container failure / report interrupted match
    Waiting --> EmptyGrace: Last member leaves
    Preparing --> EmptyGrace: Last member leaves / cancel preparation
    Playing --> EmptyGrace: All participants disconnect
    EmptyGrace --> Waiting: Return to an unstarted room
    EmptyGrace --> Playing: Match participant reconnects before deadline
    EmptyGrace --> Closing: Deadline expires
    Closing --> [*]: Stop container, remove listing, clear stored state
```

- Waiting: no container; room WebSockets use hibernation.
- Playing: roster is fixed; only existing participants may reconnect.
- Empty-match grace retains the running match for reconnects. Proposed grace:
  120 seconds. Its expiry ends the match, not merely its visibility.
- A room alarm checks persisted deadlines and current membership before cleanup.
  Returning players invalidate the old deadline.
- Host departure in Waiting transfers ownership to a remaining member.
- Match results return remaining members to the same room; a new match gets a
  new session ID and fresh container process.

## Starting a match

```mermaid
sequenceDiagram
    participant H as Host browser
    participant L as Room DO
    participant C as Rust container
    participant P as Player browsers
    H->>L: Prepare server from local disc
    L->>L: Check host and reserve capacity
    L->>C: Start selected image and wait for readiness
    H->>L: Upload required resources with scoped authorization
    L->>C: Stream private resource upload
    C-->>L: Validated content and build identity
    P->>L: Select cars and confirm readiness
    H->>L: Start match
    L->>L: Check all current participants ready and freeze roster
    L->>C: Immutable session configuration and roster
    L-->>P: Session endpoint and scoped join credentials
    P->>L: Connect using own compatible local resources
    L->>C: Forward game WebSockets
    C-->>P: Lightyear start synchronization
    Note over P,C: Gameplay remains in Lightyear, DO does not interpret ticks
    C-->>L: Match finished and results
    L-->>P: Return to room
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
    participant L as Room DO
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
        L->>L: Clear room data and alarm
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
- Bound active containers globally, room creation per user, preparation time,
  upload size and empty grace. Reserve capacity before startup; release on every
  failure/exit path. Connected but unready users must not hold preparation forever.
- Keep simulation traffic out of durable storage. Persist room transitions, not
  per-tick input or positions. Enable hibernation only where eligible; active game
  proxy connections may keep the object awake.
- Container files are temporary. Durable room metadata survives a restart;
  running match recovery after container loss is not promised in this version.
- Resource measurements and sizing limitations: [server capacity](server-capacity.md).

## Transport constraint

Cloudflare Containers use **WebSocket** for game connections in this architecture.
Lightyear 0.30.1 supports WebTransport, but the Worker/Durable Object ingress path
currently does not support incoming WebTransport sessions (checked 2026-11-12).
Enabling the Lightyear feature alone does not remove this hosting limitation.

To use WebTransport, keep the site and room on Cloudflare and host match servers
on infrastructure with public UDP/QUIC ingress. Browsers connect directly to those
servers; the room returns their endpoints and scoped admission credentials.

References: [Lightyear WebTransport](https://docs.rs/lightyear/0.30.1/lightyear/webtransport/server/index.html),
[Cloudflare support discussion](https://github.com/cloudflare/workerd/discussions/6454).

## Implementation boundary

The website provides the public room directory, creation/joining, host settings,
participants, invite links and reusable matches. Creation asks only for the player
and room names; the server supplies Deathmatch, Construction Yard and eight slots.
The host can edit those settings inside the room while others join. One room
Durable Object owns admission and permissions; the directory contains only expiring public summaries.
A private browser credential restores membership across reloads and tabs without
appearing in listings or invite URLs.

Room sockets hibernate. Persisted disconnect and empty deadlines bound reconnect
and cleanup; host departure transfers ownership. An expired empty room first
removes its directory summary, then closes sockets, calls `deleteAll()` and clears
memory. Directory-removal failures retain a future retry deadline; stale summaries
also expire independently. Explicit creation tickets expire before empty cleanup,
so old requests cannot recreate deleted rooms without leaving tombstones.

Preparation begins only after the host loads a local disc. Resource validation
precedes readiness so the native build/content identity and car catalog can be
checked. The start operation freezes all current participants, with 2–8 required;
room capacity is only an upper bound. Settings are locked during preparation,
while car/resource changes clear the affected readiness.

Each session addresses its own `TestServer` object. Directory capacity leases are
private; expired reservations destroy their old server before freeing capacity.
Persisted deadlines bound preparation and empty matches. Transient status-probe
and reservation RPC failures receive a bounded monitoring grace, preserved across
object eviction; recovery clears it. Confirmed terminal states or a changed native
session end the match immediately. Cleanup retains the session until destruction
succeeds, then resets readiness without changing room identity or useful settings. Native `results` status triggers this same path;
there is no public finish endpoint.

A room credential authorizes the WebSocket route; a private per-member match
credential assigns the native slot through the existing Resume protocol. Native
car selection is immutable for that fixed roster. Standalone Join/car selection
remains unchanged. Session-specific endpoints isolate stored reconnect tokens
from later matches. The existing container binding, Docker build and health
collector are retained; the replaced single-test-server API remains private.
No existing namespace is retired by this slice. Local Bun hosting continues to
serve `apps/server` with the API provided by a separate Rust process.

Cloudflare references: [container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/),
[WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
