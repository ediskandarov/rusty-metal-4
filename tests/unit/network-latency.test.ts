import { expect, test } from "bun:test";

import type { NetworkPort } from "@tm4/game-runtime/network/protocol";

import { networkLatency } from "../../apps/player/src/ui/network-latency.ts";

function diagnostics(patch = {}): NonNullable<NetworkPort["netDiagnostics"]> {
  return {
    receivedFrames: 1,
    transportActive: true,
    transportSampledAt: 1000,
    transport: { rttSamples: 4, rttMs: 42.6, rttSampleAgeMs: 100, ...patch } as NonNullable<
      NetworkPort["netDiagnostics"]
    >["transport"],
  };
}

test("offline, disconnected and replaced connections never expose old ping", () => {
  expect(networkLatency(false, diagnostics(), 1000).state).toBe("inactive");
  expect(networkLatency(true, { ...diagnostics(), transportActive: false }, 1000).state).toBe(
    "inactive",
  );
  expect(networkLatency(true, { receivedFrames: 0 }, 1000).state).toBe("inactive");
});

test("sample count distinguishes startup zero from measured zero", () => {
  expect(networkLatency(true, diagnostics({ rttSamples: 0, rttMs: 0 }), 1000).text).toBe("— ms");
  expect(networkLatency(true, diagnostics({ rttMs: 0 }), 1000).text).toBe("0 ms");
  expect(networkLatency(true, diagnostics({ rttMs: null }), 1000).state).toBe("waiting");
});

test("ping uses milliseconds and ages even when diagnostics stop updating", () => {
  expect(networkLatency(true, diagnostics(), 1100).text).toBe("43 ms");
  expect(networkLatency(true, diagnostics(), 4001).state).toBe("stale");
  expect(networkLatency(true, diagnostics({ rttSampleAgeMs: 3100 }), 1000).state).toBe("stale");
  expect(
    networkLatency(true, { ...diagnostics(), transportError: "unavailable" }, 1000).state,
  ).toBe("stale");
});
