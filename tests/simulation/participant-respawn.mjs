/* Focused actual-Wasm lifecycle fixtures. Run with node --test and the same
 * TM4_SIMULATION_WASM / TM4_RESOURCE_DIR inputs as the Rust simulator tests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WASI } from "node:wasi";

const compiledModule = await WebAssembly.compile(fs.readFileSync(process.env.TM4_SIMULATION_WASM));
const slots = [0, 3, 5, 7];
const identities = ["fffffffffffffffd", "0020000000000001", "ffffffffffffffff", "123456789abcdef0"];

async function simulation(model = "Orbital") {
  const wasi = new WASI({
    version: "preview1",
    preopens: { "/DATA": join(process.env.TM4_RESOURCE_DIR, "DATA") },
    returnOnExit: true,
  });
  const instance = await WebAssembly.instantiate(compiledModule, {
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
  assert.equal(x.WebNetStartMatch(8, 0xa9, 0, 12345, -1, 1, cars, ids), 1);
  x.free(cars);
  x.free(ids);
  return {
    x,
    step(buttons = 0) {
      const tick = x.HeadlessTick();
      for (const slot of slots)
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

for (const model of ["Orbital", "Crusher", "Trash Man", "Super Auger", "Sweet Tooth", "Minion"]) {
  test(`${model}: death, waiting, fresh-car recovery and rollback`, async () => {
    const world = await simulation(model);
    const x = world.x;
    for (let tick = 0; tick < 3; ++tick) world.step();
    const oldCar = x.WebTestCarHandle(0);
    assert.equal(x.WebTestSetParticipantResults(0, 2, 3), 1);
    assert.equal(x.WebTestBindCaptureTarget(7, 0), 1);
    if (["Crusher", "Trash Man"].includes(model)) assert.equal(x.WebTestBindCaptureTarget(0, 3), 1);
    const projectile = x.WebTestCreateParticipantProjectile(0);
    assert.ok(projectile);
    assert.ok(x.WebTestCreateParticipantWaveTimer(0));
    assert.ok(x.WebNetCaptureLocalCheckpoint());
    const expected = [];
    let dead, waiting, live;
    for (let tick = 3; tick < 20; ++tick) {
      if (tick === 3) assert.equal(x.WebTestKillParticipant(0), 1);
      if (tick === 4) assert.equal(x.WebTestScheduleRespawn(0, 2, 1, 3, -1), 1);
      if (tick === 8) assert.equal(x.WebTestHitParticipant(projectile, 5), 1);
      world.step();
      expected.push(world.canonical());
      if (tick === 3) {
        assert.equal(x.WebTestCarHandle(0), 0);
        assert.equal(x.WebTestRespawnState(0, 0), 1);
        assert.equal(x.WebTestNetworkSlotBindings(0), 1);
        assert.equal(x.WebTestCaptureTarget(7), 0);
        assert.deepEqual(world.results(0), [0xfffffffffffffffdn, 2, 4]);
        dead = world.snapshot();
      }
      if (tick === 4) {
        assert.equal(x.WebTestRespawnState(0, 0), 2);
        waiting = world.snapshot();
      }
      if (tick === 6) {
        assert.ok(x.WebTestCarHandle(0) > oldCar);
        assert.equal(x.WebTestNetworkSlotBindings(0), 15);
        assert.equal(x.WebTestCaptureTarget(7), 0);
        assert.deepEqual(world.results(0), [0xfffffffffffffffdn, 2, 4]);
        assert.equal(x.WebTestProjectileProvenance(projectile, 0) >>> 0, 0xfffffffd);
        assert.equal(x.WebTestProjectileProvenance(projectile, 1) >>> 0, 0xffffffff);
        assert.equal(x.WebTestProjectileProvenance(projectile, 2), 0);
        if (["Crusher", "Trash Man"].includes(model)) assert.equal(x.WebTestCaptureTarget(0), 0);
        assert.ok(x.WebTestAttributedWaves(0xfffffffd, 0xffffffff));
        live = world.snapshot();
      }
    }
    assert.deepEqual(world.results(0), [0xfffffffffffffffdn, 3, 4]);
    assert.deepEqual(world.results(5), [0xffffffffffffffffn, 0, 1]);
    assert.equal(x.WebNetRestoreLocalCheckpoint(), 1);
    for (let tick = 3; tick < 20; ++tick) {
      if (tick === 3) assert.equal(x.WebTestKillParticipant(0), 1);
      if (tick === 4) assert.equal(x.WebTestScheduleRespawn(0, 2, 1, 3, -1), 1);
      if (tick === 8) assert.equal(x.WebTestHitParticipant(projectile, 5), 1);
      world.step();
      assert.deepEqual(world.canonical(), expected[tick - 3], `rollback tick ${tick}`);
    }
    assert.equal(x.WebNetFinishLocalReplay(), 1);
    for (const [snapshot, firstTick] of [
      [dead, 4],
      [waiting, 5],
      [live, 7],
    ]) {
      const fresh = await simulation(model);
      fresh.restore(snapshot);
      assert.deepEqual(fresh.canonical(), expected[firstTick - 4]);
      for (let tick = firstTick; tick < 20; ++tick) {
        if (tick === 4) assert.equal(fresh.x.WebTestScheduleRespawn(0, 2, 1, 3, -1), 1);
        if (tick === 8) assert.equal(fresh.x.WebTestHitParticipant(projectile, 5), 1);
        fresh.step();
        assert.deepEqual(fresh.canonical(), expected[tick - 3], `portable tick ${tick}`);
      }
    }
  });
}

// Verified against typed live-car allocations in the sequence test below.
const mandatoryCrusherAllocations = new Map([
  [0, "car object"],
  [1, "behavior name"],
  [2, "weapon instances"],
  [3, "special descriptor"],
  [4, "AI damage table"],
  [5, "AI nearby table"],
  [7, "vertex colors"],
  [8, "display lists"],
  [9, "r0 groups"],
  [10, "r1 groups"],
  [11, "r2 groups"],
  [12, "collision polyhedron"],
  [13, "physics polyhedron"],
  [14, "pinchers"],
  [15, "tread faces"],
  [18, "camera controller"],
]);

function assertPlayable(world) {
  assert.equal(world.x.WebTestRespawnState(0, 0), 0);
  assert.equal(world.x.WebTestNetworkSlotBindings(0), 15);
  assert.equal(world.x.WebTestCarResource(0, 0), 3);
}

function beginCollision(world) {
  assert.ok(world.x.WebTestPlaceWeaponTarget(0));
}

function drive(world, tick) {
  // Acceleration, steering and brief machine-gun input through the real pad path.
  world.step(0x2040 | (tick < 3 ? 0x2 : 0));
}

test("Crusher respawn allocation sequence identifies mandatory physics/camera and optional effects", async () => {
  const world = await simulation("Crusher");
  const expected = Array.from({ length: 19 }, (_, i) =>
    world.x.WebTestCrusherRespawnAllocationBytes(i),
  );
  assert.ok(expected.every((bytes) => bytes > 0));
  assert.equal(world.x.WebTestKillParticipant(0), 1);
  world.step();
  assert.equal(world.x.WebTestScheduleRespawn(0, 0, 1, 1, -1), 1);
  world.step();
  assertPlayable(world);
  for (let i = 0; i < expected.length; ++i) {
    const bytes = world.x.WebTestSimulationAllocationSize(i);
    // Polyhedra keep their private shape representation; compare the observed
    // request against the live allocation's block size (wasm32 allocator unit 8).
    assert.equal(
      i === 12 || i === 13 ? Math.ceil(bytes / 8) * 8 + 8 : bytes,
      expected[i],
      `allocation ${i}: ${mandatoryCrusherAllocations.get(i) ?? "optional effect"}`,
    );
  }
});

for (const [failure, site] of mandatoryCrusherAllocations) {
  test(`failed ${site} leaves no active binding; retry, rollback and portable collision continuation`, async () => {
    const world = await simulation("Crusher");
    const expectedBytes = world.x.WebTestCrusherRespawnAllocationBytes(failure);
    assert.equal(world.x.WebTestSetParticipantResults(0, 7, 8), 1);
    assert.equal(world.x.WebTestKillParticipant(0), 1);
    world.step();
    assert.ok(world.x.WebNetCaptureLocalCheckpoint());
    world.step();
    const freeBytes = world.x.WebTestSimulationFreeBytes();
    assert.equal(world.x.WebNetRestoreLocalCheckpoint(), 1);
    assert.equal(world.x.WebTestScheduleRespawn(0, 0, 1, 1, failure), 1);
    world.step();
    assert.equal(world.x.WebNetFinishLocalReplay(), 1);
    const failedBytes = world.x.WebTestSimulationAllocationSize(failure);
    assert.equal(
      failure === 12 || failure === 13 ? Math.ceil(failedBytes / 8) * 8 + 8 : failedBytes,
      expectedBytes,
      site,
    );
    assert.equal(world.x.WebTestSimulationFreeBytes(), freeBytes, `leak after ${site}`);
    assert.equal(world.x.WebTestCarHandle(0), 0);
    assert.equal(world.x.WebTestNetworkSlotBindings(0), 1);
    assert.equal(world.x.WebTestRespawnState(0, 0), 3);
    assert.equal(world.x.WebTestRespawnState(0, 2), 1);
    assert.deepEqual(world.results(0), [0xfffffffffffffffdn, 7, 9]);
    const terminal = await simulation("Crusher");
    terminal.restore(world.snapshot());
    for (let tick = 0; tick < 12; ++tick) {
      drive(world, tick);
      drive(terminal, tick);
      assert.deepEqual(terminal.canonical(), world.canonical());
    }

    assert.equal(world.x.WebNetRestoreLocalCheckpoint(), 1);
    assert.equal(world.x.WebTestScheduleRespawn(0, 0, 1, 2, failure), 1);
    world.step();
    assert.equal(world.x.WebNetFinishLocalReplay(), 1);
    assert.equal(world.x.WebTestCarHandle(0), 0);
    assert.equal(world.x.WebTestRespawnState(0, 0), 2);
    assert.equal(world.x.WebTestRespawnState(0, 2), 1);
    assert.equal(world.x.WebTestRespawnState(0, 3), 1);
    assert.equal(world.x.WebTestSimulationFreeBytes(), freeBytes);
    const failed = world.canonical();
    const fresh = await simulation("Crusher");
    fresh.restore(world.snapshot());
    world.step();
    fresh.step();
    assertPlayable(world);
    assertPlayable(fresh);
    assert.deepEqual(world.results(0), [0xfffffffffffffffdn, 7, 9]);
    assert.deepEqual(fresh.canonical(), world.canonical());
    const spawned = world.canonical();
    beginCollision(world);
    beginCollision(fresh);
    const expected = [];
    for (let tick = 0; tick < 180; ++tick) {
      drive(world, tick);
      drive(fresh, tick);
      expected.push(world.canonical());
      assert.deepEqual(
        fresh.canonical(),
        expected[tick],
        `portable ${site} collision tick ${tick}`,
      );
    }
    assert.equal(world.x.WebNetRestoreLocalCheckpoint(), 1);
    assert.equal(world.x.WebTestScheduleRespawn(0, 0, 1, 2, failure), 1);
    world.step();
    assert.deepEqual(world.canonical(), failed);
    world.step();
    assert.deepEqual(world.canonical(), spawned);
    beginCollision(world);
    for (let tick = 0; tick < 180; ++tick) {
      drive(world, tick);
      assert.deepEqual(
        world.canonical(),
        expected[tick],
        `rollback ${site} collision tick ${tick}`,
      );
    }
    assert.equal(world.x.WebNetFinishLocalReplay(), 1);
  });
}

for (const [failure, effect] of [
  [6, "turbo display anchors"],
  [16, "engine sound object"],
  [17, "engine sound voices"],
]) {
  test(`optional ${effect} allocation failure retains complete physics/camera and portable continuation`, async () => {
    const world = await simulation("Crusher");
    assert.equal(world.x.WebTestKillParticipant(0), 1);
    world.step();
    assert.equal(world.x.WebTestScheduleRespawn(0, 0, 1, 1, failure), 1);
    world.step();
    assertPlayable(world);
    assert.equal(world.x.WebTestCarResource(0, failure === 6 ? 2 : 1), 0);
    const fresh = await simulation("Crusher");
    fresh.restore(world.snapshot());
    assertPlayable(fresh);
    assert.equal(fresh.x.WebTestCarResource(0, failure === 6 ? 2 : 1), 0);
    beginCollision(world);
    beginCollision(fresh);
    for (let tick = 0; tick < 180; ++tick) {
      drive(world, tick);
      drive(fresh, tick);
      assert.deepEqual(fresh.canonical(), world.canonical(), `optional ${effect} tick ${tick}`);
    }
  });
}

test("round completion and teardown cancel pending respawns", async () => {
  const world = await simulation();
  assert.equal(world.x.WebTestScheduleRespawn(0, 1, 1, 2, -1), 0);
  assert.equal(world.x.WebTestKillParticipant(0), 1);
  world.step();
  assert.equal(world.x.WebTestScheduleRespawn(0, 20, 1, 2, -1), 1);
  assert.equal(world.x.WebTestScheduleRespawn(0, 20, 1, 2, -1), 0);
  assert.equal(world.x.WebTestKillParticipant(3), 1);
  world.step();
  assert.equal(world.x.WebTestKillParticipant(5), 1);
  world.step();
  world.step();
  assert.equal(world.x.WebTestRespawnState(0, 0), 1);
  assert.equal(world.x.WebTestRespawnState(0, 1), 0);
  assert.equal(world.x.WebTestCarHandle(0), 0);
  assert.equal(world.x.WebTestScheduleRespawn(0, 0, 1, 2, -1), 1);
  world.step();
  assert.equal(world.x.WebTestRespawnState(0, 0), 1);
  world.x.WebNetCancelMatch();
  assert.deepEqual(world.results(0), [0n, 0, 0]);
  assert.equal(world.x.WebNetQueueTick(world.x.HeadlessTick()), 0);
});

for (const attributed of [false, true]) {
  test(`${attributed ? "weapon" : "environmental"} burning continues after source respawn`, async () => {
    const world = await simulation();
    for (let tick = 0; tick < 3; ++tick) world.step();
    assert.equal(world.x.WebTestFlameContact(attributed ? 0 : -1, 3), 1);
    assert.ok(world.x.WebNetCaptureLocalCheckpoint());
    const oldCar = world.x.WebTestCarHandle(0);
    const expected = [];
    let snapshot;
    for (let tick = 3; tick < 10; ++tick) {
      if (tick === 3) assert.equal(world.x.WebTestKillParticipant(0), 1);
      if (tick === 4) assert.equal(world.x.WebTestScheduleRespawn(0, 0, 1, 2, -1), 1);
      world.step();
      expected.push(world.canonical());
      if (tick === 4) {
        assert.ok(world.x.WebTestCarHandle(0) > oldCar);
        assert.equal(world.x.WebTestBurnIdentity(3, 0) >>> 0, attributed ? 0xfffffffd : 0);
        assert.equal(world.x.WebTestBurnIdentity(3, 1) >>> 0, attributed ? 0xffffffff : 0);
        snapshot = world.snapshot();
      }
    }
    assert.deepEqual(world.results(0), [0xfffffffffffffffdn, Number(attributed), 1]);
    assert.deepEqual(world.results(3), [0x0020000000000001n, 0, 1]);
    assert.equal(world.x.WebNetRestoreLocalCheckpoint(), 1);
    for (let tick = 3; tick < 10; ++tick) {
      if (tick === 3) assert.equal(world.x.WebTestKillParticipant(0), 1);
      if (tick === 4) assert.equal(world.x.WebTestScheduleRespawn(0, 0, 1, 2, -1), 1);
      world.step();
      assert.deepEqual(world.canonical(), expected[tick - 3]);
    }
    assert.equal(world.x.WebNetFinishLocalReplay(), 1);
    const fresh = await simulation();
    fresh.restore(snapshot);
    for (let tick = 5; tick < 10; ++tick) {
      fresh.step();
      assert.deepEqual(fresh.canonical(), expected[tick - 3]);
    }
  });
}

test("full diagnostic replay restarts with active bindings and no pending requests", async () => {
  const world = await simulation();
  const initial = world.canonical();
  assert.equal(world.x.WebTestKillParticipant(0), 1);
  world.step();
  assert.equal(world.x.WebTestScheduleRespawn(0, 20, 1, 2, -1), 1);
  world.step();
  assert.equal(world.x.WebTestRespawnState(0, 0), 2);
  assert.equal(world.x.WebTestRestartNetworkReplay(), 1);
  world.x.WebNetEndReplay();
  assert.equal(world.x.WebTestRespawnState(0, 0), 0);
  assert.equal(world.x.WebTestNetworkSlotBindings(0), 15);
  assert.deepEqual(world.results(0), [0xfffffffffffffffdn, 0, 0]);
  assert.deepEqual(world.canonical(), initial);
  assert.ok(world.snapshot());
});

for (const model of ["Orbital", "Crusher", "Trash Man", "Super Auger", "Sweet Tooth", "Minion"]) {
  test(`${model}: repeated respawns remain controllable across rollback and portable recovery`, async () => {
    const world = await simulation(model);
    let previous = world.x.WebTestCarHandle(0);
    for (let cycle = 0; cycle < 3; ++cycle) {
      assert.ok(world.x.WebNetCaptureLocalCheckpoint());
      assert.equal(world.x.WebTestKillParticipant(0), 1);
      world.step();
      const dead = world.canonical();
      assert.equal(world.x.WebTestScheduleRespawn(0, 0, 1, 2, -1), 1);
      world.step();
      assertPlayable(world);
      assert.ok(world.x.WebTestCarHandle(0) > previous);
      previous = world.x.WebTestCarHandle(0);
      const spawned = world.canonical();
      const start = [world.x.WebTestCarResource(0, 3), world.x.WebTestCarResource(0, 4)];
      const fresh = await simulation(model);
      fresh.restore(world.snapshot());
      assertPlayable(fresh);
      const expected = [];
      for (let tick = 0; tick < 90; ++tick) {
        drive(world, tick);
        drive(fresh, tick);
        expected.push(world.canonical());
        assert.deepEqual(
          fresh.canonical(),
          expected[tick],
          `cycle ${cycle}, portable tick ${tick}`,
        );
        if (tick === 2) {
          assert.ok(world.x.WebTestCarResource(0, 5));
          assert.ok(world.x.WebTestCarResource(0, 6));
          assert.equal(world.x.WebTestCarResource(0, 7), 1);
        }
      }
      assert.notDeepEqual(
        [world.x.WebTestCarResource(0, 3), world.x.WebTestCarResource(0, 4)],
        start,
      );
      assert.equal(world.results(0)[2], cycle + 1);
      assert.equal(world.x.WebNetRestoreLocalCheckpoint(), 1);
      assert.equal(world.x.WebTestKillParticipant(0), 1);
      world.step();
      assert.deepEqual(world.canonical(), dead);
      assert.equal(world.x.WebTestScheduleRespawn(0, 0, 1, 2, -1), 1);
      world.step();
      assert.deepEqual(world.canonical(), spawned);
      for (let tick = 0; tick < 90; ++tick) {
        drive(world, tick);
        assert.deepEqual(
          world.canonical(),
          expected[tick],
          `cycle ${cycle}, rollback tick ${tick}`,
        );
      }
      assert.equal(world.x.WebNetFinishLocalReplay(), 1);
    }
  });
}
