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

## Cloudflare eight-player run (2026-11-12)

The same Bedroom/Sweet Tooth/seed-12345 input scenario ran against one Linux x64
Rust/Wasmtime server in Cloudflare location `mxp06`, allocated **0.25 vCPU,
256 MiB RAM and 2 GB disk**. The authority Wasm SHA-256 is identical to the local
baseline above. The host was based on `52b62c6` plus the uncommitted HTTPS proxy
support. Eight independent browser contexts ran on the Mac; their assets were
loaded locally. Only their WebGL draw calls were suppressed in the long run;
client simulation, prediction, network input and authoritative simulation ran.

After 15 seconds of active warmup, all eight clients remained playing for
**887.773 seconds (14 min 47.8 s)**, at **29.994 authoritative ticks/s**.
Each slot contributed 26,629–26,630 driving ticks, 17,724–17,770 firing ticks and
6,210–6,223 input changes. All eight cars were alive at the last healthy sample.

| Comparable metric | Local baseline | Cloudflare |
| --- | ---: | ---: |
| Eight-player active window | 188.488 s | 887.773 s |
| Authoritative ticks/s | 30.002 | 29.994 |
| Rust CPU, percentage of one core | 12.18% | 11.99% over a 239.67 s combat subwindow |
| Process RSS | 95.18 MiB mean | 80.38 MiB at the end of that subwindow |
| WebSocket payload incoming | 136.99 kB/s | 146.46 kB/s |
| WebSocket payload outgoing | 122.88 kB/s | 114.04 kB/s |

WebSocket payload counters use the same Chrome protocol events in both runs;
these rows exclude HTTP setup and TCP/TLS/proxy overhead. The earlier local
socket-counter rows measure a different layer. CPU uses Linux `/proc` cumulative
process counters versus macOS process counters; the cloud process window is
shorter than the full session. RSS is not total container memory.

Cloudflare's recorded combat samples averaged **50.69% of the allocated CPU**,
with a highest sample of **58.88%**. Container memory averaged **101.92 MiB**,
peaking at **103.03 MiB**. After ingestion completed, the retained provider response contained all 168
five-second samples for 06:27–06:41 UTC (14 complete combat minutes).
Memory rose by about 2 MiB across the recorded combat minutes. The server retains
a bounded 8 MiB journal cache; these measurements do not establish a leak or
longer-session memory stability. Startup was excluded from combat averages.

**The 15-minute stability target did not pass.** At approximately 889 seconds,
six clients reported `The native local prediction history has a missing tick`
and disconnected. The server continued advancing; two clients remained playing.
An earlier full-render attempt hit the same error on one client after 204 seconds.
The authoritative long-run journal validated 29,820 ticks, with no unsupported
simulation state. Its incomplete marker reflects capture during deliberate
shutdown, not a completed match. Do not turn these results into a claim of stable
eight-player WAN play or conclude that the prediction error is caused by CPU/RAM.

The observed workload fits the resource allocation with headroom. Coverage is
still one map and ordinary firing, not worst-case special attacks or all maps.
Fix/reproduce the client prediction-history failure and repeat a complete long run
before accepting the allocation for production. C/Wasmtime tick p95/p99 execution
times were not measured in either baseline.

Generated inputs, harness, snapshots, provider responses, browser observations,
logs and both validated journals are under
`build/benchmarks/cloudflare-2026-11-12/` (ignored by Git). The interrupted earlier
run is retained separately in `attempt-1/`; it is not merged into the long-run
statistics. Administrative measurement and journal endpoints require both the
private test session and administrator token. Measurement now returns one bounded
Linux snapshot; the experimental long stream used during this run was replaced.

### Initial allocation decision

Keep **0.25 vCPU / 256 MiB / 2 GB** for the next stage. The observed combat
workload consumed about 0.127 vCPU on average and 0.147 vCPU at the highest
provider sample, including observers. These are sampled CPU usage values, not
maximum individual tick execution costs. Memory peaked at 40.2% of allocation.
The client prediction-history failure prevents a stability acceptance, but the
recorded resource metrics do not justify increasing CPU or RAM to address it.

| Change | Decision from these measurements |
| --- | --- |
| Increase CPU/RAM | No resource-driven need in this workload. Reconsider for missed server deadlines, memory exhaustion, or heavier scenarios. |
| Reduce memory/disk | Already at Cloudflare's custom-instance minimums: 256 MiB and 2 GB. |
| Reduce CPU to 0.1875 vCPU | Untested candidate only: the observed mean/peak would consume about 67.6%/78.5% of that budget, leaving less room for startup and complex ticks. |
| Reduce CPU to 0.125 vCPU | Reject for eight-player planning: observed mean demand already exceeds it, before workload variation. |
| Use 0.0625-vCPU lite | Below the observed eight-player CPU demand. |

Cloudflare bills CPU by active usage, while RAM and disk are billed by provisioned
size. Reducing only the CPU cap therefore does not directly reduce the cost of
the same computation. With RAM/disk already minimal, prefer the current CPU
headroom. Scaling empty containers to zero remains the useful idle-cost control.
See [instance minimums](https://developers.cloudflare.com/containers/platform/limits/)
and [CPU/memory/disk pricing](https://developers.cloudflare.com/containers/platform/pricing/).

These initial decisions precede the fixed-client repeat below. None of the runs
establishes a worst-case guarantee for every map and special attack.


## Fixed-client repeat: 0.25 versus 0.1875 vCPU

Two independent eight-client runs used the prediction-history fix at `23d9d70`,
the same Bedroom/Sweet Tooth/seed-12345 input policy and 15-second active warmup.
The authority Wasm is unchanged; the browser compatibility hash is
`6e0323cc8ccf9758ff9160773ab8b85e050e6735d66d8a5539ab89946a789f0d`.
Both containers ran in `mxp06` with 256 MiB RAM and 2 GB disk. Cloudflare's
allocation API confirmed the smaller instance actually received 0.1875 vCPU.

| Metric | 0.25 vCPU | 0.1875 vCPU |
| --- | ---: | ---: |
| Active duration | 901.028 s | 902.945 s |
| Authoritative ticks/s, HTTP observation | 30.002 | 30.006 |
| Clients playing at completion | 8 | 8 |
| Minimum observed car health | 12,106 | 8,899 |
| Cloudflare CPU, allocated-budget percentage: mean / highest sample | 50.37% / 59.52% | 52.96% / 62.21% |
| Rust CPU, percentage of one core | 12.54% | 9.77% |
| Linux container memory, mean / recorded peak | 99.90 / 101.56 MiB | 104.46 / 105.89 MiB |
| Process RSS, mean | 77.54 MiB | 78.72 MiB |
| WebSocket payload, incoming / outgoing | 146.73 / 112.59 kB/s | 146.34 / 106.76 kB/s |
| Validated authoritative journal ticks, including preparation | 30,030 | 30,060 |

**Both completed the 15-minute stability target.** No client prediction-history
failure, disconnect, unsupported simulation state or OOM occurred. Each slot
contributed about 27,000 accepted driving ticks, 18,000 firing ticks and 6,300
input changes. Journal `incomplete` markers again mean capture during deliberate
shutdown; both journals passed structural validation.

Cloudflare CPU statistics cover 168 samples across 14 complete minutes in the
first run and 180 samples across 15 complete minutes in the second. Linux CPU
windows cover 894.49 and 900.09 seconds. Do not compare process RSS with total
container memory or interpret five-second CPU samples as tick execution peaks.
Both used independent WAN clients and the same input policy, not an identical
recorded input stream. Physical host performance was not controlled.

Application health instrumentation and Workers Analytics Engine export were
added between runs at the user's request. Only the smaller profile includes this
extra work: read-only snapshots every ten seconds, counters and step histograms.
Thus these results validate two operational runs; they do not isolate the causal
cost of changing only the CPU cap. The apparent lower CPU consumption of the
smaller instance must not be read as a general efficiency gain.

### Application timing on 0.1875 vCPU

Exact differences between the read-only snapshots bracketing the combat window:

- 27,087 completed steps across 902.901 seconds: **29.99998 TPS**.
- Mean completed-step duration: **1.133 ms**. Histogram upper bounds:
  p50 ≤ 1 ms, p95 ≤ 2 ms, p99 ≤ 4 ms.
- **252 steps (0.93%) exceeded 33⅓ ms**: 134 were at most 50 ms and 118
  were between 50 and 100 ms. No step exceeded 100 ms. Exact maximum duration
  was not retained; these are histogram bounds, not individual tick traces.
- Start lateness relative to the fixed schedule averaged 0.426 ms, with
  p99 ≤ 25 ms. Ten starts exceeded 33⅓ ms; none exceeded 100 ms.
- No simulation, unsupported-state, match, journal or checkpoint-capture errors.
  Five input enqueue rejections were counted; rejection reasons were not recorded.
  Reconnection and checkpoint capture were not exercised in these runs.

These measurements include wall-clock descheduling and work through journal append
and frame enqueue, not just C execution. They do not identify whether an individual
slow step came from CPU scheduling, I/O or application work. Corresponding fine-grained
measurements do not exist for the 0.25-vCPU run, so a tail-latency comparison is still open.
See [server observability](server-observability.md) for metric semantics and queries.

**Keep 0.25 vCPU as the default.** The smaller profile successfully sustained this
workload and needs no RAM increase, but it has not demonstrated uniform 33⅓-ms
step completion. Compare both profiles with identical instrumentation before
choosing a smaller production allocation. The current measurements do not justify
increasing beyond 0.25 vCPU.

Generated evidence is in `build/benchmarks/cloudflare-fixed-2026-11-12/`:
per-profile observations, Linux snapshots, provider responses, journals and summaries;
the smaller run also retains exact health snapshots, Analytics Engine results,
allocation confirmation and instrumentation source hashes. A cold-start observer
timeout before any players joined is kept separately and excluded from the combat
results. The normal 0.25-vCPU configuration and health export were restored after
testing; the container was stopped and allocation verified at zero.
