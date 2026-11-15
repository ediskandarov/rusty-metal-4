import { expect, test } from "bun:test";

import {
  applyMembership,
  configureMatch,
  type NetworkEngine,
} from "@tm4/game-runtime/network/protocol";
import { checksum, SnapshotReplay } from "@tm4/game-runtime/network/replay";
import { messageSchema, startSchema } from "@tm4/lightyear-client/schemas";
import { startOptionsSchema } from "@tm4/rustymetal-server-client/schemas";
const start = {
  mode: "ffa" as const,
  bots: [],
  limits: { timeLimitTicks: 27000, fragLimit: 20 },
  respawnDelayTicks: 90,
  capacity: 8,
  slots: [0, 3, 7],
  participants: ["0000000000000001", "0000000000000002", "0000000000000003"],
  cars: ["Orbital", "Pizza Boy", "Crusher"],
  modelPool: ["Orbital", "Pizza Boy", "Crusher"],
  world: "Construction Yard",
  seed: 12345,
  epoch: 1,
  portable: false,
  compatibility: { protocol: 16, build: "a".repeat(64), content: "b".repeat(64) },
};
test("startup validates capacity, unique actual slots and one mode car per occupied slot", () => {
  expect(startSchema.parse(start)).toEqual(start);
  for (const invalid of [
    { limits: undefined },
    { limits: { timeLimitTicks: 0, fragLimit: 20 } },
    { limits: { timeLimitTicks: 27000, fragLimit: 0 } },
    { limits: { timeLimitTicks: 1.5, fragLimit: 20 } },
    { limits: { timeLimitTicks: 27000, fragLimit: 0x80000000 } },
    { mode: "deathmatch" },
    { modelPool: undefined },
    { modelPool: [] },
    { modelPool: ["Orbital", "Orbital", "Pizza Boy", "Crusher"] },
    { modelPool: ["Orbital", "Pizza Boy"] },
    { modelPool: ["Orbital", "Pizza Boy", "Crusher", "bad\nmodel"] },
    { modelPool: Array.from({ length: 9 }, (_, i) => `car${i}`) },
    { respawnDelayTicks: undefined },
    { respawnDelayTicks: 0 },
    { respawnDelayTicks: 3601 },
    { slots: [0, 3, 3] },
    { slots: [0, 3, 8] },
    { capacity: 7 },
    { cars: ["Orbital"] },
    { slots: [7, 3, 0] },
    { participants: undefined },
    { participants: ["0000000000000001", "0000000000000001", "0000000000000003"] },
    { participants: ["0000000000000001"] },
    { participants: ["0000000000000000", "0000000000000002", "0000000000000003"] },
    { participants: [1, 2, 3] },
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
    "WebNetStartFfa",
    8,
    0x89,
    0,
    12345,
    7,
    2,
    "Orbital\nPizza Boy\nCrusher",
    "0000000000000001\n0000000000000002\n0000000000000003",
    90,
    start.modelPool.join("\n"),
    start.limits.timeLimitTicks,
    start.limits.fragLimit,
    0,
  ]);
  expect(configureMatch(engine, start, 1)).toBe(1);
  expect(() => configureMatch(engine, start, 8)).toThrow();
});
test("portable catch-up decodes capacity-width rows but stages only the real occupied slots", async () => {
  const sections: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  const port = {
    netMatch: {
      tick: 10,
      digest: 42,
      sections,
      unsupported: null,
      nextMode: 0,
      completion: { tick: 0, reasons: 0, winners: 0 },
    },
  };
  const seen: number[][] = [];
  const engine: NetworkEngine = {
    ccall: (name) => (name === "WebNetSlotMask" ? 0x89 : 0),
    _WebNetCancelMatch() {},
    _WebNetBeginPortableReplay: () => 1,
    _WebNetSetInput(tick: number, slot: number, buttons: number) {
      seen.push([tick, slot, buttons]);
      return 1;
    },
    _WebNetQueueTick() {
      port.netMatch = {
        tick: 11,
        digest: 43,
        sections,
        unsupported: null,
        nextMode: 0,
        completion: { tick: 0, reasons: 0, winners: 0 },
      };
      return 1;
    },
    _WebNetEndReplay() {},
  };
  const replay = new SnapshotReplay(
    10,
    11,
    42,
    { capacity: 8, slots: [0, 3, 7], modelPool: start.modelPool },
    engine,
    port,
    new AbortController().signal,
  );
  const data = new Uint8Array(130 + 7 * 8);
  const view = new DataView(data.buffer);
  view.setUint32(0, 43, true);
  for (let slot = 0; slot < 8; slot++) view.setUint16(130 + 7 * slot, 100 + slot, true);
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

test("admission preconditions distinguish invalid decisions from constructor failure", () => {
  const change = {
    kind: "admit",
    identity: { slot: 2, participant: "0000000000000003" },
    car: "Orbital",
  };
  for (const [valid, constructed, expected] of [
    [0, 0, false],
    [1, 0, true],
    [1, 1, true],
  ] as const) {
    const calls: string[] = [];
    const engine: NetworkEngine = {
      ccall(name: string): number {
        calls.push(name);
        return name === "WebNetAdmissionValid" ? valid : constructed;
      },
      _WebNetSetInput: () => 1,
      _WebNetQueueTick: () => 1,
      _WebNetCancelMatch() {},
      _WebNetEndReplay() {},
      _WebNetBeginPortableReplay: () => 1,
    };
    expect(applyMembership(engine, 12, [change])).toBe(expected);
    expect(calls).toEqual(
      valid ? ["WebNetAdmissionValid", "WebNetAdmitParticipant"] : ["WebNetAdmissionValid"],
    );
  }
});

test("solo FFA keeps eight slots and rejects an empty initial roster", () => {
  const solo = {
    ...start,
    slots: [7],
    participants: [start.participants[0]!],
    cars: ["Orbital"],
    portable: true,
  };
  expect(startSchema.parse(solo)).toEqual(solo);
  expect(startSchema.safeParse({ ...solo, slots: [], participants: [], cars: [] }).success).toBe(
    false,
  );
});

test("original AI occupies one explicit seat and cannot become the local controller", () => {
  const setup = {
    ...start,
    slots: [0, 1],
    bots: [1],
    cars: start.cars.slice(0, 2),
    participants: start.participants.slice(0, 2),
  };
  expect(startSchema.parse(setup)).toEqual(setup);
  const calls: unknown[][] = [];
  const engine = {
    ccall(name: string, _result: string, _types: string[], values: unknown[]) {
      calls.push([name, ...values]);
      return 1;
    },
  } as NetworkEngine;
  expect(configureMatch(engine, setup, 0)).toBe(1);
  expect(calls.at(-1)?.at(-1)).toBe(2);
  expect(() => configureMatch(engine, setup, 1)).toThrow();
  expect(startSchema.safeParse({ ...setup, bots: [2] }).success).toBe(false);
  expect(startSchema.safeParse({ ...setup, bots: [0, 1] }).success).toBe(false);
  expect(startSchema.safeParse({ ...start, bots: [1] }).success).toBe(false);
});

test("mixed rosters keep explicit sorted bot slots and at least one human within eight seats", () => {
  const setup = {
    ...start,
    slots: [0, 1, 3, 5, 7],
    bots: [3, 5, 7],
    participants: [1, 2, 4, 6, 8].map((id) => id.toString(16).padStart(16, "0")),
    cars: ["Orbital", "Pizza Boy", "Orbital", "Pizza Boy", "Orbital"],
  };
  expect(startSchema.parse(setup)).toEqual(setup);
  for (const bots of [[3, 3], [7, 3], [2], [0, 1, 3, 5, 7]])
    expect(startSchema.safeParse({ ...setup, bots }).success).toBe(false);
  const full = {
    ...setup,
    slots: [0, 1, 2, 3, 4, 5, 6, 7],
    bots: [2, 3, 4, 5, 6, 7],
    participants: Array.from({ length: 8 }, (_, id) => (id + 1).toString(16).padStart(16, "0")),
    cars: Array(8).fill("Orbital"),
  };
  expect(startSchema.parse(full)).toEqual(full);
});

test("administrator setup shares eight slots between explicit humans and bots", () => {
  const options = {
    players: 2,
    bots: ["Orbital", "Pizza Boy", "Orbital"],
    world: "Construction Yard",
    limits: start.limits,
  };
  expect(startOptionsSchema.parse(options)).toEqual(options);
  expect(startOptionsSchema.safeParse({ ...options, players: 6 }).success).toBe(false);
  expect(startOptionsSchema.safeParse({ ...options, bot: "Orbital" }).success).toBe(false);
  expect(
    startOptionsSchema.safeParse({
      ...options,
      sessionId: "00000000-0000-4000-8000-000000000000",
      roster: [{ credential: "a".repeat(64), car: "Orbital" }],
    }).success,
  ).toBe(false);
});
