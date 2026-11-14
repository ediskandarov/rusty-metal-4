/* Actual simulation membership transactions; no browser or injected engine mocks. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WASI } from "node:wasi";
const compiledModule = await WebAssembly.compile(fs.readFileSync(process.env.TM4_SIMULATION_WASM));
const initialSlots = [0, 3, 5, 7];
const initialIds = [1n, 2n, 3n, 4n];
async function simulation() {
  const wasi = new WASI({
    version: "preview1",
    preopens: { "/DATA": join(process.env.TM4_RESOURCE_DIR, "DATA") },
    returnOnExit: true,
  });
  const { exports: x } = await WebAssembly.instantiate(compiledModule, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  wasi.initialize({ exports: x });
  const memory = () => new Uint8Array(x.memory.buffer);
  const string = (address) => {
    let end = address;
    while (memory()[end]) ++end;
    return new TextDecoder().decode(memory().subarray(address, end));
  };
  const argument = (value, run) => {
    const bytes = new TextEncoder().encode(`${value}\0`),
      address = x.malloc(bytes.length);
    memory().set(bytes, address);
    try {
      return run(address);
    } finally {
      x.free(address);
    }
  };
  assert.equal(x.HeadlessInitialize(), 1);
  argument("Orbital\nPizza Boy\nCrusher\nCrusher", (cars) =>
    argument(initialIds.map((id) => id.toString(16).padStart(16, "0")).join("\n"), (ids) =>
      assert.equal(x.WebNetStartMatch(8, 0xa9, 0, 12345, -1, 1, cars, ids), 1),
    ),
  );
  const world = {
    x,
    slots: [...initialSlots],
    step() {
      const tick = x.HeadlessTick();
      for (const slot of this.slots)
        assert.equal(x.WebNetSetInput(tick, slot, 0, 0x80808080, 0), 1);
      assert.equal(x.WebNetQueueTick(tick), 1);
    },
    admit(slot, id, model = "Orbital") {
      const accepted = argument(model, (address) =>
        x.WebNetAdmitParticipant(
          x.HeadlessTick(),
          slot,
          Number(id & 0xffffffffn),
          Number(id >> 32n),
          address,
        ),
      );
      if (accepted) this.slots.push(slot);
      this.slots.sort((a, b) => a - b);
      return accepted;
    },
    depart(slot, id) {
      const accepted = x.WebNetDepartParticipant(
        x.HeadlessTick(),
        slot,
        Number(id & 0xffffffffn),
        Number(id >> 32n),
      );
      if (accepted) this.slots = this.slots.filter((s) => s !== slot);
      return accepted;
    },
    canonical() {
      const length = x.HeadlessCapture();
      assert.ok(length, `canonical: ${string(x.HeadlessError())}`);
      return Buffer.from(memory().subarray(x.HeadlessCanonical(), x.HeadlessCanonical() + length));
    },
    snapshot() {
      const length = x.HeadlessPortableCapture();
      assert.ok(length, `snapshot: ${string(x.HeadlessError())}`);
      return Buffer.from(
        memory().subarray(x.HeadlessPortableBuffer(), x.HeadlessPortableBuffer() + length),
      );
    },
    restore(bytes, slots) {
      memory().set(bytes, x.HeadlessPortableBuffer());
      assert.equal(
        x.HeadlessPortableRestore(bytes.length),
        1,
        `restore: ${string(x.HeadlessError())}`,
      );
      this.slots = [...slots];
    },
    results(slot) {
      const offset = x.HeadlessParticipants() + slot * 16,
        view = new DataView(x.memory.buffer);
      return [
        view.getBigUint64(offset, true),
        view.getInt32(offset + 8, true),
        view.getInt32(offset + 12, true),
      ];
    },
  };
  return world;
}

test("authoritative boundary validates sparse join, departure and fresh reuse", async () => {
  const world = await simulation(),
    x = world.x;
  for (let i = 0; i < 3; ++i) world.step();
  const before = world.canonical();
  for (const [slot, id, model] of [
    [3, 8n, "Orbital"],
    [8, 8n, "Orbital"],
    [2, 0n, "Orbital"],
    [2, 1n, "Orbital"],
    [2, 8n, "Minion"],
  ])
    assert.equal(world.admit(slot, id, model), 0);
  assert.deepEqual(world.canonical(), before);
  assert.equal(world.admit(2, 9n, "Pizza Boy"), 1);
  assert.deepEqual(world.results(2), [9n, 0, 0]);
  for (const slot of [0, 2, 3, 5, 7]) assert.equal(x.WebTestNetworkSlotBindings(slot), 15);
  assert.equal(world.depart(3, 999n), 0);
  assert.equal(world.depart(3, 2n), 1);
  assert.equal(world.depart(3, 2n), 0);
  assert.equal(x.WebTestNetworkSlotBindings(3), 0);
  for (const slot of [0, 2, 5, 7]) assert.equal(x.WebTestNetworkSlotBindings(slot), 15);
  assert.equal(world.admit(3, 10n, "Crusher"), 1);
  assert.deepEqual(world.results(3), [10n, 0, 0]);
  world.step();
});

test("departure and reuse replay exactly across rollback and fresh portable recovery", async () => {
  const world = await simulation(),
    x = world.x;
  for (let i = 0; i < 3; ++i) world.step();
  assert.ok(x.WebNetCaptureLocalCheckpoint());
  const expected = [],
    snapshots = [];
  const actions = (world) => {
    const tick = world.x.HeadlessTick();
    if (tick === 3) assert.equal(world.depart(3, 2n), 1);
    if (tick === 5) assert.equal(world.admit(2, 9n, "Pizza Boy"), 1);
    if (tick === 7) assert.equal(world.admit(3, 10n, "Crusher"), 1);
  };
  for (let tick = 3; tick < 12; ++tick) {
    actions(world);
    world.step();
    expected.push(world.canonical());
    if ([3, 5, 7].includes(tick)) snapshots.push([world.snapshot(), [...world.slots], tick + 1]);
  }
  assert.equal(x.WebNetRestoreLocalCheckpoint(), 1);
  world.slots = [...initialSlots];
  for (let tick = 3; tick < 12; ++tick) {
    actions(world);
    world.step();
    assert.deepEqual(world.canonical(), expected[tick - 3], `rollback ${tick}`);
  }
  assert.equal(x.WebNetFinishLocalReplay(), 1);
  for (const [bytes, slots, tick] of snapshots) {
    const fresh = await simulation();
    fresh.restore(bytes, slots);
    assert.deepEqual(fresh.canonical(), expected[tick - 4], `restored ${tick}`);
    for (let next = tick; next < 12; ++next) {
      actions(fresh);
      fresh.step();
      assert.deepEqual(fresh.canonical(), expected[next - 3], `continued ${next}`);
    }
  }
});

test("departed projectile identity never credits the new occupant", async () => {
  const world = await simulation(),
    x = world.x;
  for (let i = 0; i < 3; ++i) world.step();
  assert.equal(x.WebTestSetParticipantResults(0, 6, 7), 1);
  const projectile = x.WebTestCreateParticipantProjectile(0);
  assert.ok(projectile);
  assert.equal(x.WebTestBindCaptureTarget(7, 0), 1);
  assert.ok(x.WebNetCaptureLocalCheckpoint());
  assert.equal(world.depart(0, 1n), 1);
  assert.equal(x.WebTestCaptureTarget(7), 0);
  assert.equal(world.admit(0, 20n), 1);
  assert.deepEqual(world.results(0), [20n, 0, 0]);
  assert.equal(x.WebTestProjectileProvenance(projectile, 0), 1);
  const fresh = await simulation();
  fresh.restore(world.snapshot(), world.slots);
  assert.equal(fresh.x.WebTestCaptureTarget(7), 0);
  assert.equal(fresh.x.WebTestProjectileProvenance(projectile, 0), 1);
  for (const current of [world, fresh]) {
    assert.equal(current.x.WebTestHitParticipant(projectile, 5), 1);
    current.step();
    assert.deepEqual(current.results(0), [20n, 0, 0]);
    assert.deepEqual(current.results(5), [3n, 0, 1]);
  }
  assert.deepEqual(fresh.canonical(), world.canonical());
  const expected = world.canonical();
  assert.equal(x.WebNetRestoreLocalCheckpoint(), 1);
  world.slots = [...initialSlots];
  assert.equal(world.depart(0, 1n), 1);
  assert.equal(world.admit(0, 20n), 1);
  assert.equal(x.WebTestHitParticipant(projectile, 5), 1);
  world.step();
  assert.deepEqual(world.canonical(), expected);
  assert.equal(x.WebNetFinishLocalReplay(), 1);
});

test("burning keeps departed provenance through slot reuse and portable continuation", async () => {
  const world = await simulation();
  for (let tick = 0; tick < 3; ++tick) world.step();
  assert.equal(world.x.WebTestFlameContact(0, 5), 1);
  assert.equal(world.depart(0, 1n), 1);
  assert.equal(world.admit(0, 20n), 1);
  assert.equal(world.x.WebTestBurnIdentity(5, 0), 1);
  const fresh = await simulation();
  fresh.restore(world.snapshot(), world.slots);
  for (let tick = 3; tick < 10; ++tick) {
    world.step();
    fresh.step();
    assert.deepEqual(fresh.canonical(), world.canonical(), `burning after reuse ${tick}`);
  }
  assert.deepEqual(world.results(0), [20n, 0, 0]);
  assert.deepEqual(world.results(5), [3n, 0, 1]);
});

test("all eight actual slots are admitted from the prepared pool and recover portably", async () => {
  const world = await simulation();
  for (let i = 0; i < 3; ++i) world.step();
  for (const [slot, id, model] of [
    [1, 31n, "Orbital"],
    [2, 32n, "Pizza Boy"],
    [4, 33n, "Crusher"],
    [6, 34n, "Crusher"],
  ])
    assert.equal(world.admit(slot, id, model), 1);
  assert.equal(world.x.WebNetSlotMask(), 255);
  for (let slot = 0; slot < 8; ++slot) assert.equal(world.x.WebTestNetworkSlotBindings(slot), 15);
  world.step();
  const bytes = world.snapshot(),
    expected = world.canonical();
  const fresh = await simulation();
  fresh.restore(bytes, world.slots);
  assert.deepEqual(fresh.canonical(), expected);
  for (let i = 0; i < 6; ++i) {
    world.step();
    fresh.step();
    assert.deepEqual(fresh.canonical(), world.canonical());
  }
});

for (let failure = 0; failure < 32; ++failure)
  test(`admission allocation ${failure}: failure publishes no ownership, RNG or resource changes`, async () => {
    const world = await simulation(),
      x = world.x;
    for (let i = 0; i < 3; ++i) world.step();
    const before = world.canonical(),
      free = x.WebTestSimulationFreeBytes();
    x.WebTestFailSimulationAllocation(failure);
    const accepted = world.admit(6, 50n, "Crusher");
    x.WebTestFailSimulationAllocation(-1);
    if (!accepted) {
      assert.deepEqual(world.canonical(), before);
      assert.equal(x.WebTestSimulationFreeBytes(), free);
      assert.equal(x.WebTestNetworkSlotBindings(6), 0);
      assert.equal(world.admit(6, 51n, "Crusher"), 1);
    } else assert.equal(x.WebTestNetworkSlotBindings(6), 15);
    world.step();
  });
