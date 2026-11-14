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

async function simulation(model = "Orbital", delay = 90) {
  const wasi = new WASI({
    version: "preview1",
    preopens: { "/DATA": join(process.env.TM4_RESOURCE_DIR, "DATA") },
    returnOnExit: true,
  });
  const instance = await WebAssembly.instantiate(compiled, {
    wasi_snapshot_preview1: wasi.wasiImport,
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
  const cars = argument([model, "Pizza Boy", "Crusher", "Crusher"].join("\n"));
  const ids = argument(identities.join("\n"));
  assert.equal(x.WebNetStartFfa(8, 0xa9, 0, 12345, -1, 1, cars, ids, delay), 1);
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
  for (let tick = 3; tick < 37; ++tick) {
    actions(world, tick);
    world.step();
    expected.push(world.canonical());
    assert.equal(status(world, 4), 0, "FFA never sets original round-finished");
    assert.equal(status(world, 6), 0, "FFA never requests an original transition");
    if ([3, 14, 25].includes(tick)) {
      assert.equal(car(world, 0), 0);
      assert.equal(pending(world, 0), 2);
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
  for (let tick = 1; tick < 70; ++tick) {
    if ([2, 32, 62].includes(tick)) x.WebTestFailSimulationAllocation(0);
    world.step();
    if ([2, 32].includes(tick)) assert.equal(pending(world, 0), 2);
    if (tick >= 62) assert.equal(pending(world, 0), 3);
    assert.equal(car(world, 0), 0);
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
