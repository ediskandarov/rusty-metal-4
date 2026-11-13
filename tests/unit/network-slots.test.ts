import { expect, test } from "bun:test";

import { configureMatch, type NetworkEngine } from "@tm4/game-runtime/network/protocol";
import { checksum, SnapshotReplay } from "@tm4/game-runtime/network/replay";
import { messageSchema, startSchema } from "@tm4/lightyear-client/schemas";
const start = {
  capacity: 8,
  slots: [0, 3, 7],
  cars: ["Orbital", "Pizza Boy", "Crusher"],
  world: "Construction Yard",
  seed: 12345,
  epoch: 1,
  portable: false,
  compatibility: { protocol: 12, build: "a".repeat(64), content: "b".repeat(64) },
};
test("startup validates capacity, unique actual slots and one mode car per occupied slot", () => {
  expect(startSchema.parse(start)).toEqual(start);
  for (const invalid of [
    { slots: [0, 3, 3] },
    { slots: [0, 3, 8] },
    { capacity: 7 },
    { cars: ["Orbital"] },
    { slots: [7, 3, 0] },
    { slots: undefined },
    { capacity: undefined },
    { portable: undefined },
    { cars: ["Orbital", "Pizza Boy\0extra", "Crusher"] },
    { cars: ["Orbital", "Pizza Boy\nextra", "Crusher"] },
  ])
    expect(startSchema.safeParse({ ...start, ...invalid }).success).toBe(false);
  const prepared = messageSchema.parse({ type: "prediction_prepare", ...start });
  if (prepared.type !== "prediction_prepare") throw new Error("Expected startup message");
  expect(prepared.slots).toEqual([0, 3, 7]);
  const calls: unknown[] = [];
  const engine = {
    ccall(name: string, _result: string, _types: string[], values: unknown[]) {
      calls.push([name, ...values]);
      return name === "WebNetWorldIndex" ? 0 : 1;
    },
  } as NetworkEngine;
  expect(configureMatch(engine, start, 7)).toBe(1);
  expect(calls).toContainEqual([
    "WebNetStartMatch",
    8,
    0x89,
    0,
    12345,
    7,
    2,
    "Orbital\nPizza Boy\nCrusher",
  ]);
  expect(() => configureMatch(engine, start, 1)).toThrow();
});
test("portable catch-up decodes capacity-width rows but stages only the real occupied slots", async () => {
  const sections: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  const port = { netMatch: { tick: 10, digest: 42, sections, unsupported: null, nextMode: 0 } };
  const seen: number[][] = [];
  const engine: NetworkEngine = {
    ccall: () => 0,
    _WebNetCancelMatch() {},
    _WebNetBeginPortableReplay: () => 1,
    _WebNetSetInput(tick: number, slot: number, buttons: number) {
      seen.push([tick, slot, buttons]);
      return 1;
    },
    _WebNetQueueTick() {
      port.netMatch = { tick: 11, digest: 43, sections, unsupported: null, nextMode: 0 };
      return 1;
    },
    _WebNetEndReplay() {},
  };
  const replay = new SnapshotReplay(
    10,
    11,
    42,
    { capacity: 8, slots: [0, 3, 7] },
    engine,
    port,
    new AbortController().signal,
  );
  const data = new Uint8Array(29 + 7 * 8);
  const view = new DataView(data.buffer);
  view.setUint32(0, 43, true);
  for (let slot = 0; slot < 8; slot++) view.setUint16(29 + 7 * slot, 100 + slot, true);
  await replay.accept({
    type: "catchup_frames",
    attempt: 1,
    start: 10,
    head: 11,
    data: [...data],
    checksum: checksum(data),
  });
  expect(seen).toEqual([
    [10, 0, 100],
    [10, 3, 103],
    [10, 7, 107],
  ]);
  replay.finish(11);
});
