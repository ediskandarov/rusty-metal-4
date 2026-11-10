import { expect, test } from "bun:test";

import type { NetworkEngine, NetworkPort } from "../../web/src/network/protocol.ts";
import { type ReplayBegin, ReplayCheckpoint } from "../../web/src/network/replay.ts";

const header: ReplayBegin = {
  type: "recovery_begin",
  schema: 1,
  epoch: 9,
  ticks: 1,
  initial_digest: 42,
  checksum: 0,
};

const neutral = { buttons: 0, axes: 0, analog: false };
const sections: [number, number, number, number, number] = [0, 0, 0, 0, 0];

test("rejects incompatible, oversized, and misordered replay checkpoints", () => {
  expect(() => new ReplayCheckpoint({ ...header, schema: 2 }, 9, 2, 42)).toThrow("Incompatible");
  expect(() => new ReplayCheckpoint({ ...header, ticks: 901 }, 9, 2, 42)).toThrow("Incompatible");
  expect(() => new ReplayCheckpoint(header, 9, 2, 43)).toThrow("Incompatible");

  const checkpoint = new ReplayCheckpoint(header, 9, 2, 42);
  expect(() =>
    checkpoint.add({
      type: "recovery_frames",
      start: 1,
      frames: [{ digest: 1, sections, inputs: [neutral, neutral] }],
    }),
  ).toThrow("Invalid replay checkpoint input block");
  expect(() =>
    checkpoint.add({
      type: "recovery_frames",
      start: 0,
      frames: [{ digest: 1, sections, inputs: [neutral, { ...neutral, buttons: 0x10000 }] }],
    }),
  ).toThrow("Invalid replay checkpoint input block");
});

test("truncated or corrupt checkpoint never resets the running game", async () => {
  let resets = 0;
  const engine = {
    _WebNetBeginReplay: () => ++resets,
  } as NetworkEngine;
  const checkpoint = new ReplayCheckpoint(header, 9, 2, 42);
  const { signal } = new AbortController();
  await expect(checkpoint.restore(engine, {}, signal)).rejects.toThrow(
    "Incomplete replay checkpoint",
  );
  expect(
    checkpoint.add({
      type: "recovery_frames",
      start: 0,
      frames: [{ digest: 1, sections, inputs: [neutral, neutral] }],
    }),
  ).toBe(true);
  await expect(checkpoint.restore(engine, {}, signal)).rejects.toThrow("Corrupt replay checkpoint");
  expect(resets).toBe(0);
});

test("abort between replay batches ends the C replay exactly once", async () => {
  const checkpoint = new ReplayCheckpoint({ ...header, ticks: 50, checksum: 311009654 }, 9, 2, 42);
  const blocks = [
    [0, 24],
    [24, 24],
    [48, 2],
  ] as const;
  for (const [start, length] of blocks) {
    checkpoint.add({
      type: "recovery_frames",
      start,
      frames: Array.from({ length }, (_, offset) => ({
        digest: start + offset + 1,
        sections,
        inputs: [neutral, neutral],
      })),
    });
  }
  const port: NetworkPort = {};
  let steps = 0;
  let ends = 0;
  const engine: NetworkEngine = {
    ccall: () => 0,
    _WebNetRequestMatch: () => 0,
    _WebNetCancelMatch() {},
    _WebNetBeginReplay() {
      port.netMatch = { tick: 0, digest: 42, sections, unsupported: null };
      return 1;
    },
    _WebNetSetInput: () => 1,
    _WebNetQueueTick(tick: number) {
      ++steps;
      port.netMatch = { tick: tick + 1, digest: tick + 1, sections, unsupported: null };
      return 1;
    },
    _WebNetEndReplay() {
      ++ends;
    },
  };

  const abort = new AbortController();
  const replay = checkpoint.restore(engine, port, abort.signal);
  const stepsBeforeAbort = steps;
  expect(stepsBeforeAbort).toBeGreaterThan(0);
  expect(stepsBeforeAbort).toBeLessThanOrEqual(24);
  abort.abort(new Error("test cancellation"));
  await expect(replay).rejects.toThrow("test cancellation");
  expect(ends).toBe(1);
  expect(steps).toBe(stepsBeforeAbort);
});
