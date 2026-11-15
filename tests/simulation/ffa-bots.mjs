/* Original-AI replay checks against actual game Wasm and stock map resources. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WASI } from "node:wasi";

const compiled = await WebAssembly.compile(fs.readFileSync(process.env.TM4_SIMULATION_WASM));
async function simulation(bot = true) {
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
  const bytes = () => new Uint8Array(x.memory.buffer);
  const string = (address) => {
    let end = address;
    while (bytes()[end]) ++end;
    return new TextDecoder().decode(bytes().subarray(address, end));
  };
  const arg = (value) => {
    const data = new TextEncoder().encode(value + "\0");
    const address = x.malloc(data.length);
    bytes().set(data, address);
    return address;
  };
  assert.equal(x.HeadlessInitialize(), 1);
  const args = [
    arg("Orbital\nPizza Boy"),
    arg("0000000000000001\n0000000000000002"),
    arg("Orbital\nPizza Boy"),
  ];
  assert.equal(
    x.WebNetStartFfa(8, 3, 0, 12345, -1, 1, args[0], args[1], 12, args[2], 27000, 100, bot ? 2 : 0),
    1,
  );
  args.forEach((address) => x.free(address));
  const read = (address, length) => Buffer.from(bytes().subarray(address, address + length));
  return {
    x,
    ai(field) {
      return x.WebTestAiState(1, field);
    },
    step(buttons = 0) {
      const tick = x.HeadlessTick();
      for (const slot of [0, 1])
        assert.equal(x.WebNetSetInput(tick, slot, slot === 0 ? buttons : 0, 0x80808080, 0), 1);
      assert.equal(x.WebNetQueueTick(tick), 1);
    },
    canonical() {
      const length = x.HeadlessCapture();
      assert.ok(length, string(x.HeadlessError()));
      return read(x.HeadlessCanonical(), length);
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
    snapshot() {
      const length = x.HeadlessPortableCapture();
      assert.ok(length, string(x.HeadlessError()));
      return read(x.HeadlessPortableBuffer(), length);
    },
    restore(snapshot) {
      bytes().set(snapshot, x.HeadlessPortableBuffer());
      assert.equal(x.HeadlessPortableRestore(snapshot.length), 1, string(x.HeadlessError()));
    },
  };
}

test("one human and one original AI retain identical canonical state at every replay tick", async () => {
  const world = await simulation();
  assert.equal(world.ai(0), 2); // CAR_CONTROL_ENEMY; no ally health policy.
  assert.equal(world.ai(9), 1, "both map navigation and character AI settings enabled");
  for (let i = 0; i < 30; ++i) world.step();
  const snapshot = world.snapshot();
  const before = world.canonical();
  assert.ok(world.x.WebNetCaptureLocalCheckpoint());
  const observations = new Set();
  const checkpoints = [];
  let targets = 0,
    routes = 0,
    weapons = 0,
    projectileTicks = 0,
    nearby = 0,
    savedStates = 0;
  const action = (current, tick) => {
    if ([80, 190, 330, 540, 650].includes(tick))
      assert.equal(current.x.WebTestPlacePlayerTarget(1, 0, 1200, 0), 1);
    if (tick === 120) assert.equal(current.x.WebTestAiRecovery(1), 1);
    if (tick === 230) assert.equal(current.x.WebTestKillParticipant(0), 1);
    if (tick === 480) assert.equal(current.x.WebTestKillParticipant(1), 1);
  };
  const expected = [];
  const started = performance.now();
  for (let tick = 0; tick < 700; ++tick) {
    action(world, tick);
    world.step(tick % 120 < 60 ? 0x4000 : 0);
    expected.push(world.canonical());
    if (tick === 230) {
      assert.equal(world.ai(4), 0);
      assert.equal(world.ai(13), 0);
      assert.equal(world.ai(12), 0);
    }
    if ([100, 120, 240, 500].includes(tick))
      checkpoints.push({ tick: tick + 1, snapshot: world.snapshot(), state: world.canonical() });
    observations.add(world.ai(1));

    targets += world.ai(4) > 0;
    routes += world.ai(2) > 1;
    weapons += world.ai(17) > 0;
    projectileTicks += world.ai(24) > 0;
    nearby += world.ai(12) > 0;
    savedStates += world.ai(11) > 0;
  }
  const stepMs = performance.now() - started;
  assert.equal(world.x.WebNetRestoreLocalCheckpoint(30), 1);
  assert.deepEqual(world.canonical(), before);
  for (let tick = 0; tick < expected.length; ++tick) {
    action(world, tick);
    world.step(tick % 120 < 60 ? 0x4000 : 0);
    assert.deepEqual(world.canonical(), expected[tick], `local replay tick ${tick}`);
  }
  const portable = await simulation();
  portable.restore(snapshot);
  assert.deepEqual(portable.canonical(), before);
  for (let tick = 0; tick < expected.length; ++tick) {
    action(portable, tick);
    portable.step(tick % 120 < 60 ? 0x4000 : 0);
    assert.deepEqual(portable.canonical(), expected[tick], `separate-instance replay tick ${tick}`);
  }

  for (const checkpoint of checkpoints) {
    const restored = await simulation();
    restored.restore(checkpoint.snapshot);
    assert.deepEqual(restored.canonical(), checkpoint.state);
    for (let tick = checkpoint.tick; tick < expected.length; ++tick) {
      action(restored, tick);
      restored.step(tick % 120 < 60 ? 0x4000 : 0);
      assert.deepEqual(restored.canonical(), expected[tick], "active portable replay tick " + tick);
    }
  }
  if (process.env.TM4_BOT_REFERENCE) {
    fs.mkdirSync(join(process.env.TM4_BOT_REFERENCE, ".."), { recursive: true });
    fs.writeFileSync(
      process.env.TM4_BOT_REFERENCE,
      JSON.stringify({
        snapshot: snapshot.toString("base64"),
        before: before.toString("base64"),
        rows: expected.map((row) => row.toString("base64")),
      }),
    );
  }
  assert.ok(weapons > 0, "original AI fired a weapon");
  assert.ok(projectileTicks > 0, "original AI created participant-attributed projectile objects");
  assert.ok(savedStates > 0, "original obstacle recovery retained its previous state callback");
  console.log({
    states: [...observations],
    targets,
    routes,
    weapons,
    projectileTicks,
    nearby,
    savedStates,
    snapshotBytes: snapshot.length,
    stepMs,
  });
  assert.ok(routes > 0, "original AI selected navigation routes");
  assert.ok(targets > 0, "original AI acquired the human target");
});

test("all three original navigation searches rewind their shared mutable resource state", async () => {
  const world = await simulation();
  for (let i = 0; i < 30; ++i) world.step();
  const start = world.ai(5),
    end = world.x.WebTestAiState(0, 5);
  assert.ok(start >= 0 && end >= 0);
  assert.ok(world.x.WebNetCaptureLocalCheckpoint());
  const snapshot = world.snapshot();
  const before = world.canonical();
  const expected = [];
  for (let i = 0; i < 180; ++i) {
    assert.ok(world.x.WebTestAiSearch(i % 3, start, end) >= 0);
    expected.push(world.canonical());
  }
  assert.equal(world.x.WebNetRestoreLocalCheckpoint(30), 1);
  assert.deepEqual(world.canonical(), before);
  for (let i = 0; i < expected.length; ++i) {
    world.x.WebTestAiSearch(i % 3, start, end);
    assert.deepEqual(world.canonical(), expected[i], `local navigation search ${i}`);
  }
  const portable = await simulation();
  portable.restore(snapshot);
  assert.deepEqual(portable.canonical(), before);
  for (let i = 0; i < expected.length; ++i) {
    portable.x.WebTestAiSearch(i % 3, start, end);
    assert.deepEqual(portable.canonical(), expected[i], `portable navigation search ${i}`);
  }
});

test("focused two-seat CPU and snapshot comparison", async () => {
  const measurements = [];
  for (const bot of [false, true]) {
    const world = await simulation(bot);
    for (let i = 0; i < 60; ++i) world.step();
    const started = performance.now();
    for (let i = 0; i < 300; ++i) world.step();
    measurements.push({
      bot,
      ticks: 300,
      stepMs: performance.now() - started,
      portableBytes: world.snapshot().length,
      localCheckpointBytes: world.x.WebNetCaptureLocalCheckpoint(),
    });
  }
  console.log(
    "Focused total simulation cost; includes physics, objects and canonical digests:",
    measurements,
  );
});

test("bot projectile scoring, waiting recovery and respawn retain the same participant", async () => {
  const world = await simulation();
  for (let tick = 0; tick < 3; ++tick) world.step();
  assert.equal(world.x.WebTestPreparePlayerDuel(1, 0, 1200), 1);
  const projectile = world.x.WebTestCreateParticipantProjectile(1);
  assert.ok(projectile);
  assert.equal(world.x.WebTestHitParticipant(projectile, 0), 1);
  world.step();
  assert.deepEqual(world.results(1), [2n, 1, 0]);
  assert.deepEqual(world.results(0), [1n, 0, 1]);
  assert.equal(world.x.WebTestKillParticipant(1), 1);
  world.step();
  assert.deepEqual(world.results(1), [2n, 1, 1]);
  const snapshot = world.snapshot();
  const restored = await simulation();
  restored.restore(snapshot);
  assert.deepEqual(restored.canonical(), world.canonical());
  for (let tick = 0; tick < 40; ++tick) {
    world.step();
    restored.step();
    assert.deepEqual(
      restored.canonical(),
      world.canonical(),
      "waiting/respawn AI replay tick " + tick,
    );
  }
  assert.equal(world.ai(0), 2);
  assert.deepEqual(world.results(1), [2n, 1, 1]);
});
