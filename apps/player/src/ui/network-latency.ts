import type { NetworkPort } from "@tm4/game-runtime/network/protocol";

// Lightyear pings every 100 ms. Give delayed packets room to arrive, but never
// keep presenting an old estimate as a live measurement after progress stops.
export const latencyStaleMs = 3000;
export type LatencyReading =
  | { state: "inactive" | "waiting" | "stale"; text: string }
  | { state: "measured"; text: string; rttMs: number };

export function networkLatency(
  online: boolean,
  diagnostics: NetworkPort["netDiagnostics"],
  now: number,
): LatencyReading {
  if (!online || !diagnostics?.transportActive) return { state: "inactive", text: "— ms" };
  const transport = diagnostics.transport;
  if (
    !transport ||
    transport.rttSamples === 0 ||
    transport.rttMs === null ||
    transport.rttSampleAgeMs === null ||
    diagnostics.transportSampledAt === undefined
  )
    return { state: "waiting", text: "— ms" };
  const age = Math.max(0, now - diagnostics.transportSampledAt) + transport.rttSampleAgeMs;
  if (diagnostics.transportError || age > latencyStaleMs)
    return { state: "stale", text: "— ms (stale)" };
  return { state: "measured", text: `${Math.round(transport.rttMs)} ms`, rttMs: transport.rttMs };
}
