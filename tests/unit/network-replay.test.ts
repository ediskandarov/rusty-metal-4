import { expect, test } from "bun:test";

import type { NetworkEngine, NetworkPort } from "../../web/src/network/protocol.ts";
import { type ReplayBegin, ReplayJournal } from "../../web/src/network/replay.ts";

const header: ReplayBegin = {
  type: "recovery_begin",
  schema: 2,
  epoch: 9,
  head: 65,
  initial_digest: 42,
};
const sections: [number, number, number, number, number] = [0, 0, 0, 0, 0];

function setup() {
  const port: NetworkPort = {};
  const counts = { steps: 0, begins: 0, ends: 0 };
  const engine: NetworkEngine = {
    ccall: () => 0,
    _WebNetRequestMatch: () => 0,
    _WebNetCancelMatch() {},
    _WebNetBeginReplay() {
      counts.begins++;
      port.netMatch = { tick: 0, digest: 42, sections, unsupported: null };
      return 1;
    },
    _WebNetSetInput: () => 1,
    _WebNetQueueTick(tick: number) {
      counts.steps++;
      port.netMatch = {
        tick: tick + 1,
        digest: tick + 1,
        sections,
        unsupported: null,
        nextMode: 0,
      };
      return 1;
    },
    _WebNetEndReplay() {
      counts.ends++;
    },
  };
  const abort = new AbortController();
  const open = (message = header) =>
    new ReplayJournal(message, 9, 2, 42, engine, port, abort.signal);
  return { abort, counts, open };
}

function chunk(start: number, ticks: number, head = header.head) {
  const rowBytes = 43;
  const bytes = new Uint8Array(ticks * rowBytes);
  const data = new DataView(bytes.buffer);
  for (let tick = 0; tick < ticks; tick++) data.setUint32(tick * rowBytes, start + tick + 1, true);
  let checksum = 2166136261;
  for (const byte of bytes) checksum = Math.imul(checksum ^ byte, 16777619);
  return {
    type: "recovery_frames" as const,
    start,
    head,
    data: Array.from(bytes),
    checksum: checksum >>> 0,
  };
}

test("rejects incompatible startup and malformed blocks before resetting the game", () => {
  const { open, counts } = setup();
  expect(() => open({ ...header, schema: 1 })).toThrow("Incompatible");
  expect(() => open({ ...header, head: 100_000_000 })).toThrow("Incompatible");
  expect(() => open({ ...header, initial_digest: 43 })).toThrow("Incompatible");
  const journal = open();
  const valid = chunk(0, 1);
  expect(() => journal.accept({ ...valid, start: 1 })).toThrow("Invalid match journal block");
  expect(() => journal.accept({ ...valid, data: valid.data.slice(0, -1) })).toThrow("Invalid");
  expect(() => journal.accept({ ...valid, checksum: 0 })).toThrow("Corrupt match journal block");
  expect(counts.begins).toBe(0);
});

test("a growing journal applies ordered chunks and ends one C replay", async () => {
  const { open, counts } = setup();
  const journal = open();
  const first = journal.accept(chunk(0, 64));
  const second = journal.accept(chunk(64, 3, 67));
  expect(() => journal.finish(67)).toThrow("Incomplete");
  expect(await first).toBe(64);
  expect(await second).toBe(67);
  journal.finish(67);
  expect(counts).toEqual({ steps: 67, begins: 1, ends: 1 });
});

test("abort between replay batches ends C replay exactly once", async () => {
  const { open, abort, counts } = setup();
  const journal = open();
  const replay = journal.accept(chunk(0, 64));
  await Promise.resolve();
  const stepsBeforeAbort = counts.steps;
  expect(stepsBeforeAbort).toBeGreaterThan(0);
  expect(stepsBeforeAbort).toBeLessThanOrEqual(24);
  abort.abort(new Error("test cancellation"));
  await expect(replay).rejects.toThrow("test cancellation");
  expect(counts).toEqual({ steps: stepsBeforeAbort, begins: 1, ends: 1 });
});

test("bounded queue refuses a fifth chunk before any application", async () => {
  const { open, abort } = setup();
  const journal = open();
  const pending = Array.from({ length: 4 }, (_, index) => journal.accept(chunk(index, 1)));
  expect(() => journal.accept(chunk(4, 1))).toThrow("Invalid match journal block");
  expect(await Promise.all(pending)).toEqual([1, 2, 3, 4]);
  expect(() => journal.finish(4)).toThrow("Incomplete");
  abort.abort();
});
