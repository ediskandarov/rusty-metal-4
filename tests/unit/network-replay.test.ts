import { expect, test } from "bun:test";

import type { NetworkEngine, NetworkPort } from "@tm4/game-runtime/network/protocol";
import { SnapshotReplay } from "@tm4/game-runtime/network/replay";

const snapshot = 420;
const head = 487;
const sections: [number, number, number, number, number] = [0, 0, 0, 0, 0];

function setup() {
  const port: NetworkPort = {
    netMatch: {
      tick: snapshot,
      digest: 42,
      sections,
      unsupported: null,
      completion: { tick: 0, reasons: 0, winners: 0 },
    },
  };
  const counts = { steps: 0, ends: 0 };
  const engine: NetworkEngine = {
    ccall: (name) => (name === "WebNetSlotMask" ? 3 : 0),
    _WebNetCancelMatch() {},
    _WebNetBeginPortableReplay: () => 1,
    _WebNetSetInput: () => 1,
    _WebNetQueueTick(tick: number) {
      counts.steps++;
      port.netMatch = {
        tick: tick + 1,
        digest: tick + 1,
        sections,
        unsupported: null,
        nextMode: 0,
        completion: { tick: 0, reasons: 0, winners: 0 },
      };
      return 1;
    },
    _WebNetEndReplay() {
      counts.ends++;
    },
  };
  const abort = new AbortController();
  const open = (start = snapshot, target = head, digest = 42) =>
    new SnapshotReplay(
      start,
      target,
      digest,
      { capacity: 2, slots: [0, 1], modelPool: ["Orbital", "Crusher"] },
      engine,
      port,
      abort.signal,
    );
  return { abort, counts, open };
}

function chunk(start: number, ticks: number, target = head) {
  const rowBytes = 130 + 7 * 2;
  const bytes = new Uint8Array(ticks * rowBytes);
  const data = new DataView(bytes.buffer);
  for (let tick = 0; tick < ticks; tick++) data.setUint32(tick * rowBytes, start + tick + 1, true);
  let checksum = 2166136261;
  for (const byte of bytes) checksum = Math.imul(checksum ^ byte, 16777619);
  return {
    type: "catchup_frames" as const,
    attempt: 1,
    start,
    head: target,
    data: Array.from(bytes),
    checksum: checksum >>> 0,
  };
}

test("rejects an unverified snapshot boundary and malformed catch-up blocks", () => {
  const { open, counts } = setup();
  expect(() => open(0)).toThrow("Invalid reconnect");
  expect(() => open(snapshot, snapshot + 241)).toThrow("Invalid reconnect");
  expect(() => open(snapshot, head, 43)).toThrow("disagrees");
  const replay = open();
  const valid = chunk(snapshot, 1);
  expect(() => replay.accept({ ...valid, start: snapshot + 1 })).toThrow("Invalid");
  expect(() => replay.accept({ ...valid, head: head + 1 })).toThrow("Invalid");
  expect(() => replay.accept({ ...valid, data: valid.data.slice(0, -1) })).toThrow("Invalid");
  expect(() => replay.accept({ ...valid, checksum: 0 })).toThrow("Corrupt");
  expect(counts.steps).toBe(0);
});

test("bounded catch-up applies ordered blocks and ends one C replay", async () => {
  const { open, counts } = setup();
  const replay = open();
  const first = replay.accept(chunk(snapshot, 64));
  expect(() => replay.accept(chunk(snapshot + 64, 3))).toThrow("Invalid");
  expect(() => replay.finish(head)).toThrow("Incomplete");
  expect(await first).toBe(snapshot + 64);
  expect(await replay.accept(chunk(snapshot + 64, 3))).toBe(head);
  replay.finish(head);
  expect(counts).toEqual({ steps: 67, ends: 1 });
});

test("abort between replay batches ends C replay exactly once", async () => {
  const { open, abort, counts } = setup();
  const replay = open();
  const pending = replay.accept(chunk(snapshot, 64));
  const stepsBeforeAbort = counts.steps;
  expect(stepsBeforeAbort).toBeGreaterThan(0);
  expect(stepsBeforeAbort).toBeLessThanOrEqual(24);
  abort.abort(new Error("test cancellation"));
  await expect(pending).rejects.toThrow("test cancellation");
  expect(counts).toEqual({ steps: stepsBeforeAbort, ends: 1 });
});

test("a checkpoint already at the agreed head requires no replay", () => {
  const { open, counts } = setup();
  open(snapshot, snapshot).finish(snapshot);
  expect(counts).toEqual({ steps: 0, ends: 1 });
});

test("retarget extends verified replay without ending or resetting its original tick budget", async () => {
  const { open, counts } = setup();
  const replay = open();
  expect(() => replay.extend(head, head + 13, head)).toThrow("Invalid");
  await replay.accept(chunk(snapshot, 64));
  await replay.accept(chunk(snapshot + 64, 3));
  expect(() => replay.extend(head, head + 13, 0)).toThrow("disagrees");
  expect(() => replay.extend(head, snapshot + 241, head)).toThrow("Invalid");
  replay.extend(head, head + 13, head);
  expect(counts.ends).toBe(0);
  expect(() => replay.finish(head)).toThrow("Incomplete");
  await replay.accept(chunk(head, 13, head + 13));
  replay.finish(head + 13);
  expect(counts).toEqual({ steps: 80, ends: 1 });
});
