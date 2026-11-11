# Server capacity baseline

Measured on 2026-11-11 at commit `e2ece4fa3efe4233d853eb06f1e777de24361ade`.
One standalone release server process, Rust + Wasmtime; no server-side browser.
This is a single-workload baseline, not a maximum-capacity result.

## Workload and measurement

- Host: Apple M3 Pro, 12 cores (6 performance + 6 efficiency), 36 GB RAM,
  macOS 15.8.3.
- Eight real network clients on the same host, connected over loopback.
  Client/browser and measurement-process costs are excluded from server accounting.
- The Bedroom; eight Sweet Tooth cars; seed 12345. Unmodified release server,
  no diagnostic gameplay actions.
- 15 seconds of active warmup, then 188.488 seconds of combat. All eight clients
  stayed connected and alive; no server overrun, unsupported state or round end.
- Each slot contributed 5,655 accepted driving ticks, including 3,759–3,782 firing
  ticks and 1,322–1,324 input changes. Steering alternated and throttle periodically
  reversed. Some cars became pinned against furniture while continuing input.
- CPU is cumulative process CPU time divided by elapsed time: 100% means one
  logical core. CPU/RSS sampling was approximately once per second.
- Network counters are native per-process socket counters over an inner 186.481-second
  window. They include periodic HTTP status polling, exclude initial asset/resource
  transfers, and do not measure full Ethernet/IP wire overhead.

## Results

| Metric | Mean | p95 | Highest sample |
| --- | ---: | ---: | ---: |
| Server CPU, one-core percentage | 12.18% | 14.63% | 16.65% |
| Server resident memory (RSS) | 95.18 MiB | — | 99.89 MiB |
| Incoming traffic, all clients | 146.61 kB/s (1.173 Mbit/s) | — | 149.35 kB/s |
| Outgoing traffic, all clients | 127.21 kB/s (1.018 Mbit/s) | — | 131.65 kB/s |

Accepted simulation rate: **30.002 ticks/s**. The authoritative journal passed
validation; its `incomplete` end marker reflects deliberate shutdown during play.

An eight-player idle lobby measured for 14 seconds used 8.45% of one core and
97.28 MiB RSS. Resource preparation/compilation took 607 ms; the first approximately
one-second CPU sample reached 66.77%. Subsecond memory peaks were not captured.
macOS physical footprint during combat averaged 39.11 MiB; use RSS for this planning
baseline. Virtual address reservations are not resident RAM.

True C/Wasmtime tick execution latency was not measured. Client receive intervals
must not be interpreted as server execution time.

## Initial allocation

For each independent server process hosting one eight-player lobby:

| Resource | Starting reservation |
| --- | --- |
| CPU | 1 modern CPU core of capacity |
| RAM | 256 MiB, with startup/peak monitoring |
| Network | 3 Mbit/s incoming and 3 Mbit/s outgoing |

These are provisional reservations with headroom, not enforced limits or proven
minimum requirements. Host OS, filesystem cache, initial uploads and static web
serving need additional capacity. One process currently hosts one lobby.

At the measured combat rate, continuous traffic would be approximately **0.53 GB/h
incoming and 0.46 GB/h outgoing per lobby** (decimal GB). Multiply by simultaneous
active lobbies and active hours; add initial downloads, reconnect traffic and
provider-specific overhead separately. This is a projection, not an hour-long test.

Do not infer eight lobbies per core from the 12% CPU average. Validate simultaneous
matches on the intended Linux/cloud CPU before CPU overcommit or reducing RAM.
The idle baseline also means empty lobbies are not free.

## Coverage limits and next measurements

This run used one map, one car type and ordinary guns. It does not establish
worst-case combat, long-session memory stability, reconnect bursts or WAN behavior.
A Nowhere To Hide trial was excluded because its round ended after 19.5 seconds.

Before production sizing, repeat with mixed cars and special attacks, measure
simultaneous reconnects and cold starts, run a full-length
match, and collect tick execution p50/p95/p99/max on the target hosting machine.

## Provenance

- Server executable SHA-256:
  `dbd2d6eec742a96998276a248542e58e2c9235ac94f02246473f009fedc60b94`
- Authority Wasm SHA-256:
  `4f8ccc4ab422a738bac4d741beee787a9e2b827aac22919b87acbf0a9920bf9c`
- Local generated evidence: `build/benchmarks/server-2026-11-11/` contains the
  summary, CPU/RSS samples, socket counters, server log and validated journal.
  These artifacts are ignored by Git; this document retains the planning baseline.
