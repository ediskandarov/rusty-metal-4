/* Focused actual-Wasm lifecycle fixtures. Run with node --test and the same
 * TM4_SIMULATION_WASM / TM4_RESOURCE_DIR inputs as the Rust simulator tests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WASI } from "node:wasi";

const compiled = await WebAssembly.compile(fs.readFileSync(process.env.TM4_SIMULATION_WASM));
const slots = [0, 3, 5, 7];
const identities = ["fffffffffffffffd", "0020000000000001", "ffffffffffffffff", "123456789abcdef0"];

async function simulation(
  model = "Orbital",
  delay = 90,
  pool = ["Orbital", "Pizza Boy", "Crusher", "Microblast", "Super Auger"],
  roster = [model, "Pizza Boy", "Crusher", "Crusher"],
  occupied = slots,
  unavailable = null,
  limits = { timeLimitTicks: 27000, fragLimit: 20 },
) {
  const wasi = new WASI({
    version: "preview1",
    preopens: { "/DATA": join(process.env.TM4_RESOURCE_DIR, "DATA") },
    returnOnExit: true,
  });
  const imports = { ...wasi.wasiImport };
  if (unavailable) {
    for (const operation of ["path_open", "path_filestat_get"]) {
      const original = imports[operation];
      imports[operation] = (...args) => {
        const path = new TextDecoder().decode(
          new Uint8Array(instance.exports.memory.buffer, args[2], args[3]),
        );
        if (path.toUpperCase().endsWith(unavailable)) return 44; // WASI ENOENT
        return original(...args);
      };
    }
  }
  const instance = await WebAssembly.instantiate(compiled, {
    wasi_snapshot_preview1: imports,
  });
  wasi.initialize(instance);
  const x = instance.exports;
  const memory = () => new Uint8Array(x.memory.buffer);
  const string = (address) => {
    let end = address;
    while (memory()[end]) ++end;
    return new TextDecoder().decode(memory().subarray(address, end));
  };
  const argument = (value) => {
    const bytes = new TextEncoder().encode(`${value}\0`);
    const address = x.malloc(bytes.length);
    memory().set(bytes, address);
    return address;
  };
  assert.equal(x.HeadlessInitialize(), 1);
  const cars = argument(roster.join("\n"));
  const ids = argument(
    occupied.map((_, i) => identities[i] ?? (i + 1).toString(16).padStart(16, "0")).join("\n"),
  );
  const models = argument(pool.join("\n"));
  assert.equal(
    x.WebNetStartFfa(
      8,
      occupied.reduce((mask, slot) => mask | (1 << slot), 0),
      0,
      12345,
      -1,
      1,
      cars,
      ids,
      delay,
      models,
      limits.timeLimitTicks,
      limits.fragLimit,
    ),
    1,
  );
  x.free(models);
  x.free(cars);
  x.free(ids);
  return {
    x,
    step(buttons = 0) {
      const tick = x.HeadlessTick();
      for (let slot = 0; slot < 8; slot++)
        if (x.WebNetSlotMask() & (1 << slot))
          assert.equal(x.WebNetSetInput(tick, slot, slot === 0 ? buttons : 0, 0x80808080, 0), 1);
      assert.equal(x.WebNetQueueTick(tick), 1);
    },
    canonical() {
      const length = x.HeadlessCapture();
      assert.ok(length, `canonical: ${string(x.HeadlessError())}`);
      return Buffer.from(memory().subarray(x.HeadlessCanonical(), x.HeadlessCanonical() + length));
    },
    snapshot() {
      const length = x.HeadlessPortableCapture();
      assert.ok(length, `capture: ${string(x.HeadlessError())}`);
      return Buffer.from(
        memory().subarray(x.HeadlessPortableBuffer(), x.HeadlessPortableBuffer() + length),
      );
    },
    restore(bytes) {
      memory().set(bytes, x.HeadlessPortableBuffer());
      assert.equal(
        x.HeadlessPortableRestore(bytes.length),
        1,
        `restore: ${string(x.HeadlessError())}`,
      );
    },
    results(slot) {
      const offset = x.HeadlessParticipants() + slot * 16;
      const view = new DataView(x.memory.buffer);
      return [
        view.getBigUint64(offset, true),
        view.getInt32(offset + 8, true),
        view.getInt32(offset + 12, true),
      ];
    },
  };
}

const car = (world, slot) => world.x.WebTestCarHandle(slot);
const status = (world, field) =>
  new DataView(world.x.memory.buffer).getInt32(world.x.HeadlessState() + field * 4, true);
const pending = (world, slot, field = 0) => world.x.WebTestRespawnState(slot, field);

test("FFA repeated simultaneous deaths preserve results, serials, attribution and recoverable policy", async () => {
  const world = await simulation("Orbital", 6);
  const x = world.x;
  for (let i = 0; i < 3; ++i) world.step();
  assert.equal(x.WebTestSetParticipantResults(0, 2, 3), 1);
  const projectile = x.WebTestCreateParticipantProjectile(0);
  let expected = [];
  const original = car(world, 0);
  assert.ok(x.WebNetCaptureLocalCheckpoint());
  const snapshots = [];
  const actions = (current, tick) => {
    if ([3, 14, 25].includes(tick)) {
      assert.equal(current.x.WebTestKillParticipant(0), 1);
      assert.equal(current.x.WebTestKillParticipant(3), 1);
      assert.equal(current.x.WebTestKillParticipant(5), 1);
    }
    if (tick === 12) assert.equal(current.x.WebTestHitParticipant(projectile, 7), 1);
  };
  let previous = original;
  const chosen = new Set();
  for (let tick = 3; tick < 37; ++tick) {
    actions(world, tick);
    world.step();
    expected.push(world.canonical());
    assert.equal(status(world, 4), 0, "FFA never sets original round-finished");
    assert.equal(status(world, 6), 0, "FFA never requests an original transition");
    if ([3, 14, 25].includes(tick)) {
      assert.equal(car(world, 0), 0);
      assert.equal(pending(world, 0), 2);
      chosen.add(pending(world, 0, 4));
      assert.equal(pending(world, 0, 1), tick + 6);
      assert.equal(status(world, 2), tick === 14 ? 0 : 1, "one or zero survivors continue");
    }
    if ([9, 20, 31].includes(tick)) {
      assert.ok(car(world, 0) > previous);
      previous = car(world, 0);
      assert.equal(pending(world, 0), 0);
      assert.equal(x.WebTestNetworkSlotBindings(0), 15);
      if (tick === 9) assert.equal(x.WebTestProjectileProvenance(projectile, 0) >>> 0, 0xfffffffd);
    }
    if ([3, 8, 9].includes(tick)) snapshots.push([world.snapshot(), tick + 1]);
  }
  assert.ok(chosen.size > 1, "multiple deaths select different models");
  assert.ok(
    [...chosen].some((model) => model >= 4),
    "selection includes models outside initial roster",
  );
  assert.deepEqual(world.results(0), [0xfffffffffffffffdn, 3, 6]);
  assert.deepEqual(world.results(7), [0x123456789abcdef0n, 0, 1]);
  assert.equal(x.WebNetRestoreLocalCheckpoint(), 1);
  for (let tick = 3; tick < 37; ++tick) {
    actions(world, tick);
    world.step();
    assert.deepEqual(world.canonical(), expected[tick - 3], "local rollback tick " + tick);
  }
  assert.equal(x.WebNetFinishLocalReplay(), 1);
  for (const [snapshot, first] of snapshots) {
    const fresh = await simulation("Orbital", 6);
    fresh.restore(snapshot);
    assert.deepEqual(fresh.canonical(), expected[first - 4]);
    for (let tick = first; tick < 37; ++tick) {
      actions(fresh, tick);
      fresh.step();
      assert.deepEqual(fresh.canonical(), expected[tick - 3], "portable tick " + tick);
    }
  }
  const mismatch = await simulation("Orbital", 7);
  assert.throws(() => mismatch.restore(snapshots[0][0]), /restore/);
});

test("FFA default waits exactly 90 ticks and membership remains available while everyone waits", async () => {
  const world = await simulation();
  const x = world.x;
  for (const slot of slots) assert.equal(x.WebTestKillParticipant(slot), 1);
  world.step();
  assert.equal(status(world, 2), 0);
  assert.equal(status(world, 4), 0);
  assert.equal(pending(world, 0, 1), 90);
  assert.equal(x.WebNetDepartParticipant(1, 3, 1, 0x00200000), 1);
  assert.equal(pending(world, 3) >>> 0, 0xffffffff);
  const name = new TextEncoder().encode("Orbital\0"),
    address = x.malloc(name.length);
  new Uint8Array(x.memory.buffer).set(name, address);
  assert.equal(x.WebNetAdmitParticipant(1, 3, 9, 0, address), 1);
  x.free(address);
  assert.deepEqual(world.results(3), [9n, 0, 0]);
  assert.equal(pending(world, 3), 0);
  assert.equal(x.WebNetDepartParticipant(1, 3, 9, 0), 1);
  for (let tick = 1; tick <= 90; ++tick) {
    world.step();
    assert.equal(status(world, 4), 0);
    if (tick < 90) assert.equal(car(world, 0), 0);
  }
  assert.ok(car(world, 0));
  assert.equal(car(world, 3), 0, "departure cancels old occupant's scheduled respawn");
});

test("FFA failed spawn retains identity/results/lease, retries three times then waits terminally", async () => {
  const world = await simulation("Crusher", 2),
    x = world.x;
  assert.equal(x.WebTestSetParticipantResults(0, 4, 5), 1);
  assert.equal(x.WebTestKillParticipant(0), 1);
  world.step();
  const selected = pending(world, 0, 4);
  for (let tick = 1; tick < 70; ++tick) {
    if ([2, 32, 62].includes(tick)) x.WebTestFailSimulationAllocation(0);
    world.step();
    if ([2, 32].includes(tick)) assert.equal(pending(world, 0), 2);
    if (tick >= 62) assert.equal(pending(world, 0), 3);
    assert.equal(car(world, 0), 0);
    assert.equal(pending(world, 0, 4), selected, "retry keeps selected model");
    assert.deepEqual(world.results(0), [0xfffffffffffffffdn, 4, 6]);
    assert.equal(x.WebNetSlotMask(), 0xa9);
    assert.equal(status(world, 4), 0);
  }
  assert.equal(pending(world, 0, 2), 3);
  const fresh = await simulation("Crusher", 2);
  fresh.restore(world.snapshot());
  for (let i = 0; i < 10; ++i) {
    world.step();
    fresh.step();
    assert.deepEqual(fresh.canonical(), world.canonical());
  }
});

test("FFA can select the same model, preserving a new lifetime and portable continuation", async () => {
  const pool = ["Crusher"],
    roster = Array(4).fill("Crusher");
  const world = await simulation("Crusher", 2, pool, roster);
  const serial = car(world, 0);
  assert.equal(world.x.WebTestKillParticipant(0), 1);
  world.step();
  assert.equal(pending(world, 0, 4), 1);
  const fresh = await simulation("Crusher", 2, pool, roster);
  fresh.restore(world.snapshot());
  for (let tick = 1; tick < 12; ++tick) {
    world.step();
    fresh.step();
    assert.deepEqual(fresh.canonical(), world.canonical());
  }
  assert.ok(car(world, 0) > serial);
  assert.equal(pending(world, 0, 4), 1);
  assert.deepEqual(world.results(0), [0xfffffffffffffffdn, 0, 1]);
});

test("pool is independent of occupancy and validates before activation or portable restore", async () => {
  for (const pool of [
    [],
    ["Orbital", "Orbital"],
    ["Missing"],
    ["Orbital", "Pizza Boy"],
    ["Orbital", "Pizza Boy", "Crusher", "Missing"],
    ["Orbital", "Pizza Boy", "Crusher", ""],
    [
      "Orbital",
      "Pizza Boy",
      "Crusher",
      "Capt. Grimm",
      "Calypso",
      "Quatro",
      "Goggle Eyes",
      "Meter Maid",
      "Gen. Warthog",
    ],
  ])
    await assert.rejects(simulation("Orbital", 2, pool));
  const world = await simulation("Orbital", 2);
  const reordered = await simulation("Orbital", 2, [
    "Pizza Boy",
    "Orbital",
    "Crusher",
    "Microblast",
    "Super Auger",
  ]);
  const before = reordered.canonical();
  assert.throws(() => reordered.restore(world.snapshot()), /restore/);
  assert.deepEqual(reordered.canonical(), before, "rejected pool does not mutate live state");
  // Recover a new instance after model changes, then admit a car absent from the
  // initial roster. All resources and callback descriptors were prepared already.
  assert.equal(world.x.WebTestKillParticipant(0), 1);
  for (let tick = 0; tick < 4; ++tick) world.step();
  let head = 4;
  while (pending(world, 0, 4) === 1) {
    assert.equal(world.x.WebTestKillParticipant(0), 1);
    for (let i = 0; i < 4; ++i) {
      world.step();
      ++head;
    }
  }
  assert.notEqual(pending(world, 0, 4), 1, "portable admission checkpoint has a changed model");
  const fresh = await simulation("Orbital", 2);
  fresh.restore(world.snapshot());
  const admit = (sim) => {
    const name = new TextEncoder().encode("Super Auger\0"),
      ptr = sim.x.malloc(name.length);
    new Uint8Array(sim.x.memory.buffer).set(name, ptr);
    assert.equal(sim.x.WebNetAdmitParticipant(head, 6, 99, 0, ptr), 1);
    sim.x.free(ptr);
  };
  admit(world);
  admit(fresh);
  assert.equal(pending(world, 6, 4), 5);
  for (let tick = head; tick < head + 16; ++tick) {
    world.step();
    fresh.step();
    assert.deepEqual(fresh.canonical(), world.canonical());
  }
});

test("eight distinct initial stock models retain separate pool identities", async () => {
  const pool = [
    "Orbital",
    "Pizza Boy",
    "Capt. Grimm",
    "Calypso",
    "Quatro",
    "Goggle Eyes",
    "Meter Maid",
    "Gen. Warthog",
  ];
  const occupied = Array.from({ length: 8 }, (_, i) => i);
  const world = await simulation("Orbital", 2, pool, pool, occupied);
  for (const slot of occupied) assert.equal(pending(world, slot, 4), slot + 1);
  const fresh = await simulation("Orbital", 2, pool, pool, occupied);
  fresh.restore(world.snapshot());
  for (const slot of occupied) {
    assert.equal(world.x.WebTestKillParticipant(slot), 1);
    assert.equal(fresh.x.WebTestKillParticipant(slot), 1);
  }
  for (let tick = 0; tick < 16; ++tick) {
    world.step();
    fresh.step();
    assert.deepEqual(fresh.canonical(), world.canonical(), "eight-slot respawn continuation");
  }
  for (const slot of occupied) assert.equal(world.x.WebTestNetworkSlotBindings(slot), 15);
});

test("partial respawn failures replay across retry boundaries without changing the selection", async () => {
  const pool = ["Crusher"],
    roster = Array(4).fill("Crusher");
  for (const allocation of [0, 4, 12, 13, 14, 15, 18]) {
    const world = await simulation("Crusher", 2, pool, roster);
    assert.equal(world.x.WebTestKillParticipant(0), 1);
    world.step();
    assert.ok(world.x.WebNetCaptureLocalCheckpoint());
    const snapshot = world.snapshot(),
      rows = [];
    for (let tick = 1; tick < 38; ++tick) {
      if (tick === 2) world.x.WebTestFailSimulationAllocation(allocation);
      world.step();
      rows.push(world.canonical());
      assert.equal(pending(world, 0, 4), 1);
    }
    assert.ok(car(world, 0), `retry after allocation ${allocation}`);
    const fresh = await simulation("Crusher", 2, pool, roster);
    fresh.restore(snapshot);
    assert.equal(world.x.WebNetRestoreLocalCheckpoint(), 1);
    for (let tick = 1; tick < 38; ++tick) {
      if (tick === 2) {
        world.x.WebTestFailSimulationAllocation(allocation);
        fresh.x.WebTestFailSimulationAllocation(allocation);
      }
      world.step();
      fresh.step();
      assert.deepEqual(
        world.canonical(),
        rows[tick - 1],
        `local failure ${allocation}, tick ${tick}`,
      );
      assert.deepEqual(
        fresh.canonical(),
        rows[tick - 1],
        `portable failure ${allocation}, tick ${tick}`,
      );
    }
    assert.equal(world.x.WebNetFinishLocalReplay(), 1);
  }
});

test("a known pool model with missing local disc resources is rejected before activation", async () => {
  await assert.rejects(simulation("Orbital", 2, undefined, undefined, slots, "AUGER.MR"));
  await assert.rejects(simulation("Orbital", 2, undefined, undefined, slots, "YARD.MR"));
});

const completion = (world) => [30, 31, 32].map((field) => status(world, field));
const limited = (timeLimitTicks, fragLimit = 20) =>
  simulation("Orbital", 2, ["Orbital", "Pizza Boy"], ["Orbital", "Pizza Boy"], [0, 7], null, {
    timeLimitTicks,
    fragLimit,
  });

test("FFA timeout completes exactly one full tick, preserves ties and freezes terminal gameplay", async () => {
  const world = await limited(6),
    x = world.x;
  const expected = [];
  for (let tick = 0; tick < 5; tick++) world.step(tick % 2 ? 0x42 : 0);
  assert.deepEqual(completion(world), [0, 0, 0]);
  assert.equal(status(world, 4), 0);
  const before = world.snapshot();
  assert.ok(x.WebNetCaptureLocalCheckpoint());
  // A death in the ending tick schedules a later spawn, then completion cancels it.
  const action = (current) => assert.equal(current.x.WebTestKillParticipant(0), 1);
  action(world);
  world.step(0x42);
  assert.deepEqual(completion(world), [6, 1, 0x81]);
  assert.equal(status(world, 4), 1);
  assert.equal(status(world, 5), 0);
  assert.equal(status(world, 6), 0, "no original menu/transition request");
  assert.notEqual(pending(world, 0), 2, "completion cancels scheduled respawn");
  const after = world.snapshot();
  const cars = [car(world, 0), car(world, 7)];
  const gameplaySections = [9, 10, 11, 12].map((field) => status(world, field));
  for (let tick = 6; tick <= 10; tick++) {
    expected.push(world.canonical());
    world.step(tick % 2 ? 0x42 : 0);
    assert.deepEqual(completion(world), [6, 1, 0x81]);
    assert.deepEqual([car(world, 0), car(world, 7)], cars);
    assert.deepEqual(
      [9, 10, 11, 12].map((field) => status(world, field)),
      gameplaySections,
      "terminal steps freeze complete cars, objects, world and sound state",
    );
    assert.deepEqual(world.results(0).slice(1), [0, 1]);
  }
  const model = x.malloc(8);
  new Uint8Array(x.memory.buffer).set(new TextEncoder().encode("Orbital\0"), model);
  assert.equal(x.WebNetAdmitParticipant(11, 3, 55, 0, model), 0);
  assert.equal(x.WebNetDepartParticipant(11, 0, 0xfffffffd, 0xffffffff), 0);
  x.free(model);
  assert.equal(x.WebNetRestoreLocalCheckpoint(), 1);
  assert.deepEqual(completion(world), [0, 0, 0]);
  action(world);
  world.step(0x42);
  for (let tick = 6; tick <= 10; tick++) {
    assert.deepEqual(world.canonical(), expected[tick - 6], "rollback across end " + tick);
    world.step(tick % 2 ? 0x42 : 0);
  }
  assert.equal(x.WebNetFinishLocalReplay(), 1);
  for (const [snapshot, first] of [
    [before, 5],
    [after, 6],
  ]) {
    const restored = await limited(6);
    restored.restore(snapshot);
    if (first === 5) {
      action(restored);
      restored.step(0x42);
    }
    for (let tick = 6; tick <= 10; tick++) {
      assert.deepEqual(restored.canonical(), expected[tick - 6], "portable across end " + tick);
      restored.step(tick % 2 ? 0x42 : 0);
    }
  }
  const mismatch = await limited(7);
  assert.throws(() => mismatch.restore(after), /restore/);
});

test("FFA 19 to 20 frags evaluates simultaneous scores, including tied time and frag limits", async () => {
  for (const time of [2, 100]) {
    const world = await limited(time),
      x = world.x;
    assert.equal(x.WebTestSetParticipantResults(0, 19, 5), 1);
    assert.equal(x.WebTestSetParticipantResults(7, 19, 2), 1);
    world.step();
    assert.deepEqual(completion(world), [0, 0, 0]);
    assert.ok(x.WebNetCaptureLocalCheckpoint());
    const before = world.snapshot();
    // Detached effects already carry both identities before the simultaneous deaths.
    const action = (current) => {
      const a = current.x.WebTestCreateParticipantProjectile(0);
      const b = current.x.WebTestCreateParticipantProjectile(7);
      assert.equal(current.x.WebTestHitParticipant(a, 7), 1);
      assert.equal(current.x.WebTestHitParticipant(b, 0), 1);
    };
    action(world);
    world.step();
    assert.deepEqual(world.results(0).slice(1), [20, 6]);
    assert.deepEqual(world.results(7).slice(1), [20, 3]);
    assert.deepEqual(completion(world), [2, time === 2 ? 3 : 2, 0x81]);
    const canonical = world.canonical(),
      after = world.snapshot();
    assert.equal(x.WebNetRestoreLocalCheckpoint(), 1);
    action(world);
    world.step();
    assert.deepEqual(world.canonical(), canonical);
    assert.equal(x.WebNetFinishLocalReplay(), 1);
    for (const snapshot of [before, after]) {
      const fresh = await limited(time);
      fresh.restore(snapshot);
      if (fresh.x.HeadlessTick() === 1) {
        action(fresh);
        fresh.step();
      }
      assert.deepEqual(fresh.canonical(), canonical);
      fresh.step();
      assert.deepEqual(completion(fresh), [2, time === 2 ? 3 : 2, 0x81]);
    }
  }
});

test("FFA admission on the ending tick participates, while later admission is fenced", async () => {
  const world = await limited(3),
    x = world.x;
  world.step();
  world.step();
  const before = world.snapshot();
  assert.ok(x.WebNetCaptureLocalCheckpoint());
  const admit = (current) => {
    const address = current.x.malloc(8);
    new Uint8Array(current.x.memory.buffer).set(new TextEncoder().encode("Orbital\0"), address);
    const accepted = current.x.WebNetAdmitParticipant(current.x.HeadlessTick(), 3, 55, 0, address);
    current.x.free(address);
    return accepted;
  };
  assert.equal(admit(world), 1);
  world.step(0x42);
  assert.deepEqual(completion(world), [3, 1, 0x89]);
  const expected = world.canonical(),
    after = world.snapshot();
  assert.equal(x.WebNetRestoreLocalCheckpoint(), 1);
  assert.equal(admit(world), 1);
  world.step(0x42);
  assert.deepEqual(world.canonical(), expected);
  assert.equal(x.WebNetFinishLocalReplay(), 1);
  for (const snapshot of [before, after]) {
    const fresh = await limited(3);
    fresh.restore(snapshot);
    if (fresh.x.HeadlessTick() === 2) {
      assert.equal(admit(fresh), 1);
      fresh.step(0x42);
    }
    assert.deepEqual(fresh.canonical(), expected);
    assert.equal(admit(fresh), 0);
  }
});

test("solo FFA supports late admission across rollback and portable recovery", async () => {
  const create = () => simulation("Orbital", 2, ["Orbital", "Pizza Boy"], ["Orbital"], [0]);
  const world = await create();
  for (let i = 0; i < 3; i++) world.step();
  assert.deepEqual(completion(world), [0, 0, 0]);
  const before = world.snapshot();
  assert.ok(world.x.WebNetCaptureLocalCheckpoint());
  const admit = (current) => {
    const model = current.x.malloc(10);
    new Uint8Array(current.x.memory.buffer).set(new TextEncoder().encode("Pizza Boy\0"), model);
    assert.equal(current.x.WebNetAdmitParticipant(3, 7, 55, 0, model), 1);
    current.x.free(model);
  };
  admit(world);
  const expected = [];
  for (let i = 3; i < 10; i++) {
    world.step();
    expected.push(world.canonical());
  }
  assert.equal(world.x.WebNetSlotMask(), 129);
  const after = world.snapshot();
  assert.equal(world.x.WebNetRestoreLocalCheckpoint(), 1);
  admit(world);
  for (let i = 3; i < 10; i++) {
    world.step();
    assert.deepEqual(world.canonical(), expected[i - 3]);
  }
  assert.equal(world.x.WebNetFinishLocalReplay(), 1);
  const restored = await create();
  restored.restore(before);
  admit(restored);
  for (let i = 3; i < 10; i++) {
    restored.step();
    assert.deepEqual(restored.canonical(), expected[i - 3]);
  }
  const joined = await create();
  joined.restore(after);
  assert.deepEqual(joined.canonical(), world.canonical());
});

const invisibilityInput = [1 << 14, 0, 1 << 14, 0, 1 << 12, 0, 1 << 12, 0];
const shieldInput = [1 << 12, 0, 1 << 12, 0, 1 << 13, 0];

for (const [shieldTick, deathTick] of [
  [null, null],
  [20, null],
  [60, null],
  [null, 20],
  [null, 60],
]) {
  test(`invisibility recovery (shield at ${shieldTick}, death at ${deathTick})`, async () => {
    const world = await simulation();
    for (let i = 0; i < 10; ++i) world.step();
    assert.ok(world.x.WebNetCaptureLocalCheckpoint());
    const before = world.snapshot();
    const input = (tick) => {
      if (tick >= 10 && tick < 10 + invisibilityInput.length) return invisibilityInput[tick - 10];
      if (shieldTick !== null && tick >= shieldTick && tick < shieldTick + shieldInput.length)
        return shieldInput[tick - shieldTick];
      return 0;
    };
    const advance = (current, tick) => {
      if (tick === deathTick) assert.equal(current.x.WebTestKillParticipant(0), 1);
      current.step(input(tick));
    };
    const expected = [],
      snapshots = [[10, before]];
    for (let tick = 10; tick < 240; ++tick) {
      advance(world, tick);
      expected.push(world.canonical());
      // Mid-fade, hidden, shield overlap and after expiry.
      if ([17, 28, 55, 75, 150, 210].includes(tick)) snapshots.push([tick + 1, world.snapshot()]);
    }
    assert.equal(world.x.WebNetRestoreLocalCheckpoint(), 1);
    for (let tick = 10; tick < 240; ++tick) {
      advance(world, tick);
      assert.deepEqual(world.canonical(), expected[tick - 10], `rollback tick ${tick}`);
    }
    assert.equal(world.x.WebNetFinishLocalReplay(), 1);
    for (const [nextTick, snapshot] of snapshots) {
      const restored = await simulation();
      restored.restore(snapshot);
      restored.x.WebNetEndReplay();
      assert.deepEqual(restored.snapshot(), snapshot, `round trip at ${nextTick}`);
      assert.ok(restored.x.WebNetCaptureLocalCheckpoint());
      for (let tick = nextTick; tick < 240; ++tick) {
        advance(restored, tick);
        assert.deepEqual(restored.canonical(), expected[tick - 10], `portable tick ${tick}`);
      }
      assert.equal(restored.x.WebNetRestoreLocalCheckpoint(), 1);
      for (let tick = nextTick; tick < 240; ++tick) {
        advance(restored, tick);
        assert.deepEqual(restored.canonical(), expected[tick - 10], `active rollback tick ${tick}`);
      }
      assert.equal(restored.x.WebNetFinishLocalReplay(), 1);
    }
  });
}
