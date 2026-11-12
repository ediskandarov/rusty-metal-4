import { expect, test } from "bun:test";

import {
  exportHealth,
  type HealthSnapshot,
  parseHealth,
} from "../../apps/cloudflare/src/telemetry.ts";
const snapshot = (boot: string, uptimeSeconds: number, ticks: number): HealthSnapshot => ({
  schema: 1,
  boot,
  uptimeSeconds,
  phase: "match",
  measurements: [
    { name: "tm4_simulation_ticks_total", kind: "counter", value: ticks },
    { name: "tm4_players_connected", kind: "gauge", value: 8 },
  ],
});
function points(current: HealthSnapshot, previous?: HealthSnapshot) {
  const rows: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];
  exportHealth(
    {
      writeDataPoint: (point) => {
        rows.push(point);
      },
    },
    "object",
    0.1875,
    current,
    previous,
  );
  return rows;
}
test("counter increases retain the actual interval and gauges stay absolute", () => {
  const rows = points(snapshot("one", 30, 600), snapshot("one", 20, 300));
  expect(rows[0]!.doubles).toEqual([600, 300, 10]);
  expect(rows[1]!.doubles).toEqual([8, 0, 0]);
  expect(rows[0]!.blobs[6]).toBe("0.1875");
  expect(rows[0]!.indexes).toEqual(["object"]);
});
test("first scrape and process restart cannot manufacture ticks or a rate", () => {
  expect(points(snapshot("one", 20, 300))[0]!.doubles).toEqual([300, 0, 0]);
  expect(points(snapshot("two", 20, 600), snapshot("one", 20, 300))[0]!.doubles).toEqual([
    600, 0, 0,
  ]);
  expect(points(snapshot("one", 10, 300), snapshot("one", 20, 600))[0]!.doubles).toEqual([
    300, 0, 0,
  ]);
});
test("slot and histogram bucket identity keep independent counter histories", () => {
  const a = snapshot("one", 10, 300),
    b = snapshot("one", 20, 600);
  for (const value of [a, b])
    value.measurements = [0, 1].map((slot) => ({
      name: "tm4_input_received_total",
      kind: "counter",
      value: slot * 10 + value.uptimeSeconds,
      slot,
    }));
  expect(points(b, a).map((p) => p.doubles)).toEqual([
    [20, 10, 10],
    [30, 10, 10],
  ]);
});
test("invalid or unbounded snapshots are rejected before any Analytics Engine writes", () => {
  expect(parseHealth(snapshot("one", 10, 300)).schema).toBe(1);
  for (const value of [
    null,
    {},
    { ...snapshot("one", 10, 300), schema: 2 },
    { ...snapshot("one", 10, 300), uptimeSeconds: -1 },
  ])
    expect(() => parseHealth(value)).toThrow();
  const duplicate = snapshot("one", 10, 300);
  duplicate.measurements.push(duplicate.measurements[0]!);
  expect(() => parseHealth(duplicate)).toThrow();
  const invalid = snapshot("one", 10, 300);
  invalid.measurements[0]!.value = Number.NaN;
  expect(() => parseHealth(invalid)).toThrow();
});
