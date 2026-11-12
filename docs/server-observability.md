# Server health telemetry

The Rust server exposes an administrator-only `GET /api/metrics` JSON snapshot.
Collection reads bounded counters and histograms; it does not call the simulator.
The Cloudflare Durable Object collects a snapshot every ten seconds while its
container is running and writes it to the `tm4_server_health` Analytics Engine
dataset. It never starts a container for telemetry. Empty-container collection
expires with the idle budget; a collection failure does not terminate a match.

Snapshots include completed ticks, last-tick age, tick duration and scheduling
lateness, connected players, per-slot received-input counters and ages, reliable
messages awaiting acknowledgement, reconnect admissions, checkpoint capture and
journal/simulation errors. Unacknowledged-message counts are not socket queue bytes.
Client prediction errors and checksums are not yet uploaded as telemetry.

Tick duration covers input staging, C simulation, journal append and frame
publication for a successfully completed authoritative step. Lateness measures
actual step start against a 30 Hz schedule anchored at the first executed step;
it does not measure startup or client/network latency. The timer uses `Instant`.
Histogram buckets are cumulative, including `+Inf`. The finite boundaries are
1, 2, 4, 8, 16, 25, 33⅓, 50, 100 and 250 milliseconds.

## Analytics Engine schema 1

Each point has the Durable Object ID as its single sampling index.

| Column | Meaning |
| --- | --- |
| `blob1` | Metric name |
| `blob2` | `counter` or `gauge` |
| `blob3` | Slot `0`–`7`, or empty |
| `blob4` | Histogram upper bound in seconds, or empty |
| `blob5` | Server phase |
| `blob6` | Process boot identity |
| `blob7` | Allocated vCPU |
| `double1` | Absolute counter/gauge value |
| `double2` | Counter increase since the previous snapshot |
| `double3` | Observed interval in seconds for that counter increase |

Gauge points have zero in `double2` and `double3`. A new process or first
collection establishes a baseline with no inferred increase. The baseline is
stored in Durable Object storage so collector eviction does not reset rates.
The collector's own `tm4_telemetry_scrape_success` gauge stores 1/0 in `double1`;
its remaining columns are unused. Telemetry is best effort, not an accounting log.

For example, completed ticks per second, accounting for Analytics Engine sampling:

```sql
SELECT blob7 AS vcpu,
       SUM(_sample_interval * double2) / SUM(_sample_interval * double3) AS tps
FROM tm4_server_health
WHERE timestamp > NOW() - INTERVAL '1' HOUR
  AND blob1 = 'tm4_simulation_ticks_total'
  AND blob5 = 'match' AND double3 > 0
GROUP BY blob7
```

For a duration distribution, sum weighted `double2` grouped by `blob4` for
`tm4_simulation_tick_duration_seconds_bucket`. Use the same time/phase/CPU filter
for every bucket. Gauges use `double1`; do not sum cumulative histogram values.
Cloudflare's CPU, memory and network metrics remain separate infrastructure data.
